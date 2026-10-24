// Phase 12: dependency-free helpers behind the refresh cookie and the
// per-account login lockout.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { REFRESH_COOKIE, parseCookies, serializeRefreshCookie, clearRefreshCookie, cookieOptionsFromEnv } from "../src/utils/cookies.js";
import { createLoginGuard } from "../src/utils/loginGuard.js";

describe("refresh-token cookie", () => {
  test("is httpOnly, SameSite=Strict, path-scoped and Secure by default", () => {
    const opts = cookieOptionsFromEnv({});
    assert.deepEqual(opts, { path: "/api/v1/auth", secure: true });
    const c = serializeRefreshCookie("abc.def.ghi", { maxAgeSeconds: 604800, ...opts });
    assert.equal(c, `${REFRESH_COOKIE}=abc.def.ghi; Path=/api/v1/auth; Max-Age=604800; HttpOnly; SameSite=Strict; Secure`);
  });
  test("COOKIE_SECURE=false (local HTTP) drops only the Secure flag", () => {
    const c = serializeRefreshCookie("t", { maxAgeSeconds: 10, ...cookieOptionsFromEnv({ COOKIE_SECURE: "false" }) });
    assert.match(c, /HttpOnly; SameSite=Strict$/);
  });
  test("clearing sets Max-Age=0", () => {
    assert.match(clearRefreshCookie({ path: "/api/v1/auth", secure: true }), /^sc_refresh=; Path=\/api\/v1\/auth; Max-Age=0;/);
  });
  test("parseCookies reads the cookie among others and ignores junk", () => {
    assert.deepEqual(parseCookies("a=1; sc_refresh=x.y.z; b=%41"), { a: "1", sc_refresh: "x.y.z", b: "A" });
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies("=nameless; ok=1; bad=%E0%A4%A"), { ok: "1", bad: "%E0%A4%A" });
    assert.equal(parseCookies("sc_refresh=first; sc_refresh=second").sc_refresh, "first");
  });
});

describe("per-account login lockout", () => {
  test("locks after maxFailures for the window, counts unknown emails the same way, resets on success", () => {
    let t = 0;
    const g = createLoginGuard({ maxFailures: 3, windowMs: 1000, now: () => t });
    for (const email of ["real@x.io", "nobody@x.io"]) {
      assert.equal(g.isLocked(email), false);
      g.recordFailure(email);
      g.recordFailure(email);
      assert.equal(g.isLocked(email), false);
      g.recordFailure(email);
      assert.equal(g.isLocked(email), true, `${email} locked after 3 failures`);
    }
    assert.equal(g.retryAfterSeconds("real@x.io"), 1);
    t = 1000;
    assert.equal(g.isLocked("real@x.io"), false, "window over");
    g.recordFailure("a@x.io");
    g.recordSuccess("a@x.io");
    g.recordFailure("a@x.io");
    g.recordFailure("a@x.io");
    assert.equal(g.isLocked("a@x.io"), false, "success reset the count");
  });
  test("memory stays bounded", () => {
    const g = createLoginGuard({ maxFailures: 1, windowMs: 10_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) g.recordFailure(`u${i}@x.io`);
    assert.ok(g.isLocked("u999@x.io"));
  });
});
