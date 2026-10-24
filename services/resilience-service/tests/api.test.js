import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { verifyAccessToken, TokenError } from "../src/jwt.js";
import { createApp } from "../src/index.js";
import { ResilienceEngine } from "../src/runner.js";
import { buildScenarios } from "../src/scenarios.js";
import { createFakeCluster } from "./fakeCluster.js";
import { createRabbitAdmin } from "../src/rabbit.js";

const SECRET = "test-secret";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload, { secret = SECRET, alg = "HS256" } = {}) {
  const h = b64({ alg, typ: "JWT" });
  const p = b64({ iss: "sentinelcloud-auth-service", type: "access", exp: Math.floor(Date.now() / 1000) + 600, ...payload });
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

describe("jwt", () => {
  test("valid token → payload", () => {
    assert.equal(verifyAccessToken(sign({ sub: "1", role: "SYSTEM_ADMIN" }), SECRET).role, "SYSTEM_ADMIN");
  });
  test("rejects tampering, wrong secret, expiry, alg none, wrong issuer, refresh tokens", () => {
    const good = sign({ role: "CITIZEN" });
    const [h, , s] = good.split(".");
    const forged = `${h}.${b64({ iss: "sentinelcloud-auth-service", role: "SYSTEM_ADMIN", exp: 9999999999 })}.${s}`;
    assert.throws(() => verifyAccessToken(forged, SECRET), TokenError);
    assert.throws(() => verifyAccessToken(sign({}, { secret: "other" }), SECRET), /bad signature/);
    assert.throws(() => verifyAccessToken(sign({ exp: 1 }), SECRET), /expired/);
    assert.throws(() => verifyAccessToken(sign({}, { alg: "none" }), SECRET), /unsupported alg/);
    assert.throws(() => verifyAccessToken(sign({ iss: "evil" }), SECRET), /issuer/);
    assert.throws(() => verifyAccessToken(sign({ type: "refresh" }), SECRET), /access token/);
    assert.throws(() => verifyAccessToken("garbage", SECRET), /malformed/);
  });
});

describe("HTTP API", () => {
  let server;
  let base;
  let cluster;
  before(async () => {
    cluster = createFakeCluster();
    const rabbit = createRabbitAdmin({ baseUrl: "http://rabbitmq:15672", user: "u", password: "p", request: cluster.request });
    const engine = new ResilienceEngine({
      scenarios: buildScenarios(), k8s: cluster.k8s, rabbit, request: cluster.request,
      cfg: { replicas: 2, normalMs: 2000, holdMs: 10, pollMs: 5, sampleMs: 10, probeIntervalMs: 10, prepareTimeoutMs: 3000, detectTimeoutMs: 3000, recoverTimeoutMs: 3000, restoreTimeoutMs: 3000, load: { concurrency: 1, workMs: 1 }, broker: {}, chaosToken: "t" },
    });
    server = http.createServer(createApp({ engine, jwtSecret: SECRET, k8s: cluster.k8s }));
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.close();
    cluster.stop();
  });

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };
  const admin = () => sign({ sub: "1", email: "admin@sentinelcloud.local", role: "SYSTEM_ADMIN" });
  const operator = () => sign({ sub: "2", role: "EMERGENCY_OPERATOR" });

  test("health is public; everything else needs a token", async () => {
    assert.equal((await call("GET", "/health")).status, 200);
    assert.equal((await call("GET", "/scenarios")).status, 401);
    assert.equal((await call("GET", "/runs/current")).status, 401);
  });

  test("any authenticated user can read scenarios and the overview", async () => {
    const s = await call("GET", "/scenarios", { token: operator() });
    assert.equal(s.status, 200);
    assert.equal(s.body.available, true);
    assert.equal(s.body.scenarios.length, 6);
    const o = await call("GET", "/overview", { token: operator() });
    assert.equal(o.status, 200);
    assert.equal(o.body.services.length, 4);
    assert.ok(o.body.services[0].pods.length >= 1);
  });

  test("only SYSTEM_ADMIN may start a drill", async () => {
    const r = await call("POST", "/runs", { token: operator(), body: { scenarioId: "hospital-failure" } });
    assert.equal(r.status, 403);
  });

  test("start → current shows it → second start conflicts → abort", async () => {
    const start = await call("POST", "/runs", { token: admin(), body: { scenarioId: "hospital-failure" } });
    assert.equal(start.status, 202);
    assert.equal(start.body.run.startedBy, "admin@sentinelcloud.local");
    const cur = await call("GET", "/runs/current", { token: operator() });
    assert.equal(cur.body.run.status, "running");
    assert.equal((await call("POST", "/runs", { token: admin(), body: { scenarioId: "power-failure" } })).status, 409);
    assert.equal((await call("POST", "/runs/current/abort", { token: admin() })).status, 202);
    for (let i = 0; i < 200; i++) {
      const c = await call("GET", "/runs/current", { token: admin() });
      if (c.body.run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal((await call("GET", "/runs/current", { token: admin() })).body.run.status, "aborted");
  });

  test("unknown scenario → 400; bad JSON → 400", async () => {
    assert.equal((await call("POST", "/runs", { token: admin(), body: { scenarioId: "nope" } })).status, 400);
    const res = await fetch(base + "/runs", { method: "POST", headers: { Authorization: `Bearer ${admin()}` }, body: "{not json" });
    assert.equal(res.status, 400);
  });

  test("/metrics exposes drill metrics", async () => {
    const m = await call("GET", "/metrics");
    assert.equal(m.status, 200);
    assert.match(m.body, /sentinel_resilience_run_active/);
    assert.match(m.body, /sentinel_resilience_runs_total\{scenario="hospital-failure",outcome="aborted"\} 1.0/);
  });
});

