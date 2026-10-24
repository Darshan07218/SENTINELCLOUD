import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { analyzeApiPath } from "../src/security/pathGuard.js";
import { createRateLimiter } from "../src/security/rateLimiter.js";
import { checkUpgrade, tokenFromProtocols, parseProtocols, originAllowed } from "../src/security/wsAuth.js";
import { isPublicPath, writeRolesFor, ANY_AUTHENTICATED } from "../src/routeAccessRules.js";

const PREFIXES = new Set(["auth", "hospitals", "ambulances", "blood-banks", "power", "disasters", "notifications", "resilience"]);

describe("analyzeApiPath", () => {
  test("normal paths pass and are split into prefix + rest", () => {
    assert.deepEqual(analyzeApiPath("/hospitals/42", PREFIXES), { ok: true, prefix: "hospitals", rest: "/42", normalized: "/hospitals/42" });
    assert.equal(analyzeApiPath("/power/transformers/x/readings", PREFIXES).ok, true);
    assert.equal(analyzeApiPath("/blood-banks/", PREFIXES).rest, "/");
  });
  test("mixed-case prefixes are refused (role table bypass)", () => {
    for (const p of ["/HOSPITALS/1", "/Hospitals", "/hosPitals/x", "/%68ospitals/1".replace("%68", "H")]) {
      const r = analyzeApiPath(p, PREFIXES);
      assert.equal(r.ok, false, p);
      assert.equal(r.status, 404);
    }
  });
  test("internal endpoints are blocked in any case or encoding", () => {
    for (const p of [
      "/power/internal/chaos",
      "/power/INTERNAL/chaos",
      "/power/%69nternal/chaos",
      "/hospitals/x/internal",
      "/hospitals/%49nternal/whoami",
    ]) {
      const r = analyzeApiPath(p, PREFIXES);
      assert.equal(r.ok, false, p);
      assert.equal(r.status, 404, p);
    }
  });
  test("infrastructure endpoints of services are not proxied", () => {
    for (const p of ["/blood-banks/health", "/power/prometheus", "/hospitals/metrics", "/power/info", "/power/actuator/env", "/auth/Health/ready"]) {
      assert.equal(analyzeApiPath(p, PREFIXES).ok, false, p);
    }
  });
  test("dot segments, encoded slashes to dot segments, backslashes and bad encodings are rejected", () => {
    for (const p of ["/hospitals/../auth/x", "/hospitals/%2e%2e/auth", "/hospitals/..%2F..%2Fauth", "/hospitals/a\\b", "/hospitals/%zz", "/hospitals/%00"]) {
      const r = analyzeApiPath(p, PREFIXES);
      assert.equal(r.ok, false, p);
    }
  });
  test("unknown prefixes", () => {
    assert.equal(analyzeApiPath("/", PREFIXES).ok, false);
    assert.equal(analyzeApiPath("/admin", PREFIXES).status, 404);
  });
});

describe("access rules", () => {
  test("public paths are exact", () => {
    assert.equal(isPublicPath("/auth/login"), true);
    assert.equal(isPublicPath("/auth/refresh"), true);
    assert.equal(isPublicPath("/auth/logout"), true);
    assert.equal(isPublicPath("/auth/register"), true);
    assert.equal(isPublicPath("/auth/docs/swagger-ui.css"), true);
    assert.equal(isPublicPath("/auth/login/../me"), false);
    assert.equal(isPublicPath("/auth/loginx"), false);
    assert.equal(isPublicPath("/auth/me"), false);
    assert.equal(isPublicPath("/auth/users"), false);
    assert.equal(isPublicPath("/hospitals"), false);
  });
  test("write roles fail closed for unknown prefixes", () => {
    assert.deepEqual(writeRolesFor("hospitals"), ["HOSPITAL_ADMIN", "SYSTEM_ADMIN"]);
    assert.deepEqual(writeRolesFor("resilience"), ["SYSTEM_ADMIN"]);
    assert.equal(writeRolesFor("auth"), ANY_AUTHENTICATED);
    assert.deepEqual(writeRolesFor("something-new"), []);
    assert.deepEqual(writeRolesFor("HOSPITALS"), []);
  });
});

describe("rate limiter", () => {
  function fakeRes() {
    return {
      headers: {},
      statusCode: 200,
      body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
  }
  test("allows up to the limit per key, then 429 with Retry-After, then resets", () => {
    let t = 0;
    const limited = [];
    const mw = createRateLimiter({ name: "api", windowMs: 60_000, limit: 3, keyFn: (r) => r.ip, now: () => t, onLimited: (req, info) => limited.push(info.key) });
    const run = (ip) => { const res = fakeRes(); let passed = false; mw({ ip }, res, () => { passed = true; }); return { res, passed }; };
    assert.equal(run("a").passed, true);
    assert.equal(run("a").passed, true);
    const third = run("a");
    assert.equal(third.passed, true);
    assert.equal(third.res.headers["RateLimit-Remaining"], "0");
    const fourth = run("a");
    assert.equal(fourth.passed, false);
    assert.equal(fourth.res.statusCode, 429);
    assert.equal(fourth.res.headers["Retry-After"], "60");
    assert.deepEqual(limited, ["a"]);
    assert.equal(run("b").passed, true, "other keys are independent");
    t = 60_000;
    assert.equal(run("a").passed, true, "new window");
  });
  test("skip and empty keys bypass the limiter; memory is bounded", () => {
    let t = 0;
    const mw = createRateLimiter({ name: "x", windowMs: 1000, limit: 1, keyFn: (r) => r.ip, skip: (r) => r.skip, now: () => t, maxKeys: 10 });
    const res = fakeRes();
    let n = 0;
    mw({ ip: "a", skip: true }, res, () => n++);
    mw({ ip: "a", skip: true }, res, () => n++);
    mw({ ip: undefined }, res, () => n++);
    assert.equal(n, 3);
    for (let i = 0; i < 50; i++) mw({ ip: `k${i}` }, fakeRes(), () => {});
    assert.ok(mw.size() <= 10);
  });
});

describe("WebSocket handshake check", () => {
  const verifyToken = (t) => {
    if (t === "good") return { sub: "u1", role: "CITIZEN" };
    throw new Error("bad");
  };
  const opts = { allowedOrigins: ["http://localhost:5173"], verifyToken };
  const req = (over = {}) => ({ url: "/ws/live", headers: { host: "localhost:30080", origin: "http://localhost:30080", "sec-websocket-protocol": "sentinel-live, bearer.good", ...over.headers }, ...over.top });

  test("accepts same-origin with a valid token", () => {
    assert.deepEqual(checkUpgrade(req(), opts), { ok: true, user: { id: "u1", role: "CITIZEN" } });
  });
  test("accepts an allow-listed cross origin (Vite dev server)", () => {
    assert.equal(checkUpgrade(req({ headers: { host: "localhost:8080", origin: "http://localhost:5173" } }), opts).ok, true);
  });
  test("rejects foreign origins, missing/invalid tokens and other paths", () => {
    assert.equal(checkUpgrade(req({ headers: { origin: "https://evil.example" } }), opts).status, 403);
    assert.equal(checkUpgrade(req({ headers: { "sec-websocket-protocol": "sentinel-live" } }), opts).status, 401);
    assert.equal(checkUpgrade(req({ headers: { "sec-websocket-protocol": "sentinel-live, bearer.bad" } }), opts).status, 401);
    assert.equal(checkUpgrade(req({ top: { url: "/ws/other" } }), opts).status, 404);
    assert.equal(checkUpgrade(req({ top: { url: "/ws/live/../x" } }), opts).status, 404);
  });
  test("through nginx: Host keeps the port ($http_host), so same-origin matches; a client-sent X-Forwarded-Host only counts behind a trusted proxy", () => {
    // What nginx forwards for a page on http://localhost:30080
    assert.equal(checkUpgrade(req({ headers: { host: "localhost:30080", origin: "http://localhost:30080" } }), opts).ok, true);
    // nginx's $host would drop the port — that mismatch is exactly why the template uses $http_host
    assert.equal(checkUpgrade(req({ headers: { host: "localhost", origin: "http://localhost:30080" } }), opts).status, 403);
    // A direct client (no trusted proxy) can't vouch for its own origin with X-Forwarded-Host
    const spoof = req({ headers: { host: "gateway:8080", origin: "https://evil.example", "x-forwarded-host": "evil.example" } });
    assert.equal(checkUpgrade(spoof, opts).status, 403);
    assert.equal(checkUpgrade(spoof, { ...opts, trustForwardedHost: true }).ok, true, "only when a proxy is trusted to set it");
  });

  test("token in the query string is NOT accepted (it would end up in access logs)", () => {
    assert.equal(checkUpgrade(req({ top: { url: "/ws/live?access_token=good" }, headers: { "sec-websocket-protocol": "sentinel-live" } }), opts).status, 401);
  });
  test("helpers", () => {
    assert.deepEqual(parseProtocols(" a, b ,c"), ["a", "b", "c"]);
    assert.equal(tokenFromProtocols("sentinel-live, bearer.xyz"), "xyz");
    assert.equal(tokenFromProtocols("sentinel-live"), null);
    assert.equal(originAllowed(undefined, { allowedOrigins: [], host: "h" }), true);
    assert.equal(originAllowed("not a url", { allowedOrigins: [], host: "h" }), false);
  });
});
