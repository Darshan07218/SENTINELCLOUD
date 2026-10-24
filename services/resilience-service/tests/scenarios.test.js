import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeCluster } from "./fakeCluster.js";
import { ResilienceEngine, STAGES, ConflictError, UnavailableError } from "../src/runner.js";
import { buildScenarios } from "../src/scenarios.js";
import { createRabbitAdmin } from "../src/rabbit.js";

const FAST = {
  replicas: 2,
  normalMs: 60,
  holdMs: 30,
  pollMs: 5,
  sampleMs: 10,
  probeIntervalMs: 5,
  prepareTimeoutMs: 3000,
  detectTimeoutMs: 3000,
  recoverTimeoutMs: 3000,
  restoreTimeoutMs: 3000,
  load: { concurrency: 3, workMs: 1 },
  broker: { produceEveryMs: 5, consumePerSec: 400, consumeEveryMs: 20, backlogMs: 60 },
  chaosToken: "t",
};

const clusters = [];
after(() => clusters.forEach((c) => c.stop()));

function setup(cfgOverrides = {}, clusterOpts = {}) {
  const cluster = createFakeCluster(clusterOpts);
  clusters.push(cluster);
  const rabbit = createRabbitAdmin({ baseUrl: "http://rabbitmq:15672", user: "u", password: "p", request: cluster.request });
  const engine = new ResilienceEngine({ scenarios: buildScenarios(), k8s: cluster.k8s, rabbit, request: cluster.request, cfg: { ...FAST, ...cfgOverrides } });
  return { cluster, engine };
}

async function runToEnd(engine, id) {
  engine.start(id, { startedBy: "admin@test" });
  await engine.settled();
  return engine.current();
}

function assertAllStagesInOrder(run) {
  const times = STAGES.map((s) => run.stages.find((x) => x.stage === s).enteredAt);
  assert.ok(times.every(Boolean), `every stage reached: ${JSON.stringify(run.stages.map((s) => [s.stage, s.enteredAt]))} error=${run.error}`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], `${STAGES[i]} after ${STAGES[i - 1]}`);
  assert.equal(run.stage, "RESTORED");
}

describe("pod-failure scenarios", () => {
  test("hospital-failure: hang → NotReady → liveness restart → back in rotation", async () => {
    const { cluster, engine } = setup();
    const run = await runToEnd(engine, "hospital-failure");
    assert.equal(run.status, "completed", run.error);
    assertAllStagesInOrder(run);
    assert.equal(run.stages.find((s) => s.stage === "FAILURE").enteredAt !== null, true);
    assert.match(run.stages[1].summary, /stopped responding/);
    assert.match(run.stages[2].summary, /Readiness probe failed/);
    assert.match(run.stages[2].evidence || "", /Readiness probe failed: HTTP probe failed with statuscode: 503/);
    assert.match(run.stages[3].summary, /Liveness probe failed/);
    assert.match(run.stages[3].evidence || "", /failed liveness probe, will be restarted/);
    // the failed pod restarted exactly once and nobody deleted anything
    assert.equal(run.summary.restarts, 1);
    assert.equal(cluster.deleted.length, 0);
    // load balancing: during the incident the healthy replica kept serving
    assert.ok(run.summary.requestsDuringIncident.ok > 0);
    assert.ok(Object.keys(run.summary.requestsDuringIncident.servedBy).length >= 1);
    // the view shows both replicas and per-pod traffic
    assert.equal(run.view.kind, "pods");
    assert.ok(run.view.traffic.length > 0);
    // cleanup: HPA minReplicas raised to 2 for the drill, then restored to 1
    assert.deepEqual(cluster.patches.map((p) => p.patch.spec.minReplicas), [2, 1]);
    assert.equal(run.banner.headline, "SERVICE RESTORED");
  });

  test("ambulance-failure: crash → container restart", async () => {
    const { engine } = setup();
    const run = await runToEnd(engine, "ambulance-failure");
    assert.equal(run.status, "completed", run.error);
    assertAllStagesInOrder(run);
    assert.match(run.stages[2].summary, /exit code 1/);
    assert.match(run.stages[3].summary, /restartPolicy: Always/);
  });

  test("blood-failure: Spring liveness BROKEN → restart", async () => {
    const { engine } = setup();
    const run = await runToEnd(engine, "blood-failure");
    assert.equal(run.status, "completed", run.error);
    assertAllStagesInOrder(run);
    assert.match(run.stages[1].summary, /LivenessState = BROKEN/);
  });

  test("power-failure: pod deleted → ReplicaSet creates a replacement", async () => {
    const { cluster, engine } = setup();
    const run = await runToEnd(engine, "power-failure");
    assert.equal(run.status, "completed", run.error);
    assertAllStagesInOrder(run);
    assert.equal(cluster.deleted.length, 1);
    assert.notEqual(run.summary.replacementPod, run.summary.lostPod);
    assert.ok(!cluster.pods.has(run.summary.lostPod), "the lost pod is gone for good");
    assert.ok(cluster.pods.get(run.summary.replacementPod).ready, "replacement is ready");
    assert.match(run.stages[3].summary, /ReplicaSet controller created a replacement pod/);
  });
});

describe("traffic surge", () => {
  test("surge → HPA desired ↑ → scale-out → settled", async () => {
    const { cluster, engine } = setup();
    const run = await runToEnd(engine, "traffic-surge");
    assert.equal(run.status, "completed", run.error);
    assertAllStagesInOrder(run);
    assert.equal(run.banner.headline, "CAPACITY RESTORED");
    assert.equal(run.summary.replicasBefore, 1);
    assert.ok(run.summary.replicasAfter >= 3, `scaled out to ${run.summary.replicasAfter}`);
    assert.match(run.stages[2].summary, /HorizontalPodAutoscaler measured CPU at 240%/);
    assert.equal(run.view.kind, "scaling");
    assert.ok(cluster.readyCount("ambulance-service") >= 3);
  });

  test("no HPA reaction (e.g. metrics-server missing) → fails with an explanation", async () => {
    const { engine } = setup({ detectTimeoutMs: 300 }, { hpaReacts: false });
    const run = await runToEnd(engine, "traffic-surge");
    assert.equal(run.status, "failed");
    assert.match(run.error, /metrics-server/);
    assert.equal(run.stage, "FAILURE");
  });
});

describe("broker failure", () => {
  test("delay → queue builds → broker killed → events buffered → recreated → backlog drains, nothing lost", async () => {
    const { cluster, engine } = setup();
    const run = await runToEnd(engine, "broker-failure");
    assert.equal(run.status, "completed", run.error);
    assertAllStagesInOrder(run);
    assert.deepEqual(cluster.deleted, ["rabbitmq-0"]);
    assert.ok(run.summary.queuedAtFailure > 0, "queue built up before the outage");
    assert.ok(run.summary.peakBufferedInOutbox > 0, "events were buffered during the outage");
    assert.ok(run.summary.peakQueueDepth >= run.summary.queuedAtFailure);
    assert.equal(run.summary.eventsLost, 0);
    assert.match(run.stages[2].summary, /services report their RabbitMQ connection closed/);
    assert.match(run.stages[3].summary, /StatefulSet controller recreated rabbitmq-0/);
    assert.equal(run.view.kind, "broker");
    assert.ok(run.view.services.every((s) => s.connected));
  });
});

describe("engine safety", () => {
  test("only one drill at a time", async () => {
    const { engine } = setup();
    engine.start("hospital-failure");
    assert.throws(() => engine.start("power-failure"), ConflictError);
    engine.abort();
    await engine.settled();
  });

  test("abort mid-drill → status aborted, faults cleared, HPA restored", async () => {
    const { cluster, engine } = setup({ normalMs: 20 });
    engine.start("hospital-failure");
    // wait until the fault is injected
    for (let i = 0; i < 200 && engine.current().stage !== "FAILURE"; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(engine.current().stage, "FAILURE");
    engine.abort();
    await engine.settled();
    const run = engine.current();
    assert.equal(run.status, "aborted");
    assert.ok([...cluster.pods.values()].every((p) => p.fault === null), "faults cleared by cleanup");
    assert.equal(cluster.hpas.get("hospital-service").min, 1);
    assert.ok(run.timeline.some((e) => e.kind === "cleanup"));
  });

  test("not in Kubernetes → drills unavailable, with the reason", () => {
    const engine = new ResilienceEngine({ scenarios: buildScenarios(), k8s: null, rabbit: null, request: async () => ({}), cfg: FAST });
    assert.equal(engine.scenarios().available, false);
    assert.match(engine.scenarios().reason, /not running inside Kubernetes/);
    assert.throws(() => engine.start("hospital-failure"), UnavailableError);
  });

  test("no chaos token → unavailable", () => {
    const { cluster } = setup();
    const engine = new ResilienceEngine({ scenarios: buildScenarios(), k8s: cluster.k8s, rabbit: null, request: cluster.request, cfg: { ...FAST, chaosToken: "" } });
    assert.match(engine.scenarios().reason, /CHAOS_TOKEN/);
  });

  test("catalogue lists the six required scenarios", () => {
    const ids = buildScenarios().map((s) => s.id);
    assert.deepEqual(ids, ["hospital-failure", "ambulance-failure", "blood-failure", "power-failure", "traffic-surge", "broker-failure"]);
  });
});
