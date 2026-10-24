// Phase 12: security behaviour of the drill API (separate file: each test
// file runs in its own process, so its fake cluster is fully isolated).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
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

describe("Phase 12: security of the drill API", () => {
  let server;
  let base;
  let cluster;
  const audits = [];
  before(async () => {
    cluster = createFakeCluster();
    const rabbit = createRabbitAdmin({ baseUrl: "http://rabbitmq:15672", user: "u", password: "p", request: cluster.request });
    const engine = new ResilienceEngine({
      scenarios: buildScenarios(), k8s: cluster.k8s, rabbit, request: cluster.request,
      cfg: { replicas: 2, normalMs: 50, holdMs: 10, pollMs: 5, sampleMs: 10, probeIntervalMs: 10, prepareTimeoutMs: 3000, detectTimeoutMs: 3000, recoverTimeoutMs: 3000, restoreTimeoutMs: 3000, load: { concurrency: 1, workMs: 1 }, broker: {}, chaosToken: "t" },
    });
    server = http.createServer(createApp({ engine, jwtSecret: SECRET, k8s: cluster.k8s, audit: (e) => audits.push(e) }));
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.close();
    cluster.stop();
  });

  test("401 never explains why a token was rejected", async () => {
    const res = await fetch(`${base}/scenarios`, { headers: { Authorization: `Bearer ${sign({ sub: "1" }, { alg: "none" })}` } });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.doesNotMatch(body.error.message, /alg|signature|expired|issuer/i);
  });

  test("responses carry baseline security headers", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("drill start / denied attempts / abort are written to the audit log", async () => {
    const post = (path, token, body) =>
      fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Request-Id": "rid-42" }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await post("/runs", sign({ sub: "2", role: "CITIZEN" }), { scenarioId: "power-failure" })).status, 403);
    assert.equal((await post("/runs", sign({ sub: "1", email: "admin@x", role: "SYSTEM_ADMIN" }), { scenarioId: "power-failure" })).status, 202);
    assert.equal((await post("/runs/current/abort", sign({ sub: "1", role: "SYSTEM_ADMIN" }))).status, 202);
    const actions = audits.map((a) => `${a.action}:${a.outcome}`);
    assert.deepEqual(actions, ["drill.start:denied", "drill.start:success", "drill.abort:success"]);
    assert.equal(audits[1].actor.id, "1");
    assert.equal(audits[1].requestId, "rid-42");
    assert.equal(audits[1].resource.scenario, "power-failure");
  });
});
