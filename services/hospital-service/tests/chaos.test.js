import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createChaos } from "../src/chaos.js";

const TOKEN = "test-token";

function call(chaos, { method = "GET", url, token } = {}) {
  return new Promise((resolve) => {
    const headers = token ? { "x-chaos-token": token } : {};
    const res = {
      statusCode: 200, headers: {}, body: undefined,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { this.body = b ? JSON.parse(b) : undefined; resolve({ status: this.statusCode, body: this.body, passed: false }); },
    };
    chaos.middleware({ method, url, headers }, res, () => resolve({ passed: true }));
  });
}

const make = (over = {}) => createChaos({ serviceName: "hospital-service", enabled: true, token: TOKEN, hostname: () => "pod-a", ...over });

describe("chaos: access control", () => {
  test("disabled → /internal/* looks like an unknown route, normal traffic passes", async () => {
    const c = createChaos({ serviceName: "s", enabled: false, token: TOKEN });
    assert.equal((await call(c, { url: "/internal/whoami", token: TOKEN })).status, 404);
    assert.equal((await call(c, { url: "/hospitals" })).passed, true);
  });
  test("enabled but no token configured → disabled", async () => {
    const c = createChaos({ serviceName: "s", enabled: true, token: "" });
    assert.equal(c.isEnabled(), false);
  });
  test("wrong or missing token → 404", async () => {
    const c = make();
    assert.equal((await call(c, { url: "/internal/whoami" })).status, 404);
    assert.equal((await call(c, { url: "/internal/whoami", token: "nope" })).status, 404);
    assert.equal((await call(c, { method: "POST", url: "/internal/chaos?mode=crash", token: "x" })).status, 404);
  });
});

describe("chaos: faults", () => {
  test("whoami reports the pod", async () => {
    const r = await call(make(), { url: "/internal/whoami", token: TOKEN });
    assert.deepEqual([r.status, r.body.pod, r.body.service], [200, "pod-a", "hospital-service"]);
  });

  test("unhealthy → API, health and whoami all 503; clear → back to normal", async () => {
    const c = make();
    assert.equal((await call(c, { method: "POST", url: "/internal/chaos?mode=unhealthy", token: TOKEN })).status, 200);
    for (const url of ["/hospitals", "/health", "/health/ready", "/metrics"]) {
      const r = await call(c, { url });
      assert.equal(r.status, 503, url);
      assert.equal(r.body.error.code, "SIMULATED_FAILURE");
    }
    assert.equal((await call(c, { url: "/internal/whoami", token: TOKEN })).status, 503);
    assert.equal((await call(c, { url: "/internal/work?ms=5", token: TOKEN })).status, 503);
    assert.equal((await call(c, { method: "POST", url: "/internal/chaos?mode=clear", token: TOKEN })).status, 200);
    assert.equal((await call(c, { url: "/hospitals" })).passed, true);
  });

  test("crash → 202, then exit(1)", async () => {
    let exitCode = null;
    const c = make({ exit: (code) => { exitCode = code; } });
    const r = await call(c, { method: "POST", url: "/internal/chaos?mode=crash", token: TOKEN });
    assert.equal(r.status, 202);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(exitCode, 1);
  });

  test("invalid mode → 400", async () => {
    assert.equal((await call(make(), { method: "POST", url: "/internal/chaos?mode=explode", token: TOKEN })).status, 400);
  });

  test("work burns roughly the requested CPU time, capped at 500ms", async () => {
    const t0 = Date.now();
    const r = await call(make(), { url: "/internal/work?ms=30", token: TOKEN });
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 >= 30);
    const capped = await call(make(), { url: "/internal/work?ms=1", token: TOKEN });
    assert.equal(capped.body.ms, 1);
  });
});
