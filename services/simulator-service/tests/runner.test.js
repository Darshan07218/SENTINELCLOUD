// Phase 16: the scenario runner and the gateway client, with a fake clock
// and a fake gateway.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRunner, createActions, ConflictError, telemetryStatus } from "../src/runner.js";
import { createGatewayClient, BudgetExceeded, AMBIENT_WRITE_CAP } from "../src/gatewayClient.js";
import { SCENARIOS } from "../src/scenarios.js";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; await Promise.resolve(); } };
}

const SCENARIO = {
  id: "demo",
  title: "Demo",
  ambient: true,
  steps: [
    { at: 0, action: "a", say: "first" },
    { at: 10, action: "b", say: "second" },
    { at: 20, action: "c", say: "third" },
    { at: 30, action: "clean", say: "tidy up", cleanup: true },
  ],
};

function harness({ failOn } = {}) {
  const calls = [];
  const clock = fakeClock();
  const ambient = { on: false, setEnabled(v) { this.on = v; return v; }, isEnabled() { return this.on; } };
  const actions = new Proxy({}, {
    get: (_t, name) => async () => {
      calls.push({ name, at: clock.now() });
      if (name === failOn) throw new Error(`${name} broke`);
      return `${name} done`;
    },
  });
  const runner = createRunner({ actions, ambient, scenarios: [SCENARIO], clock, log: { log() {}, warn() {}, error() {} } });
  return { runner, calls, ambient, clock };
}

describe("createRunner", () => {
  test("runs every step at its offset and switches background mode on", async () => {
    const h = harness();
    const started = h.runner.start("demo", { startedBy: "admin@x" });
    assert.equal(started.status, "RUNNING");
    await h.runner.settled();
    assert.deepEqual(h.calls.map((c) => [c.name, c.at]), [["a", 0], ["b", 10_000], ["c", 20_000], ["clean", 30_000]]);
    const run = h.runner.current();
    assert.equal(run.status, "COMPLETED");
    assert.ok(run.steps.every((s) => s.status === "DONE" && s.detail.endsWith("done")));
    assert.equal(h.ambient.on, true);
  });

  test("a failed step is recorded and the run carries on", async () => {
    const h = harness({ failOn: "b" });
    h.runner.start("demo");
    await h.runner.settled();
    const run = h.runner.current();
    assert.equal(run.status, "COMPLETED_WITH_ERRORS");
    assert.deepEqual(run.steps.map((s) => s.status), ["DONE", "FAILED", "DONE", "DONE"]);
    assert.equal(run.steps[1].detail, "b broke");
  });

  test("stop skips the rest but still runs clean-up steps", async () => {
    const h = harness();
    h.runner.start("demo");
    assert.equal(h.runner.stop(), true); // before even the first step started
    await h.runner.settled();
    const run = h.runner.current();
    assert.equal(run.status, "STOPPED");
    assert.deepEqual(run.steps.map((s) => s.status), ["SKIPPED", "SKIPPED", "SKIPPED", "DONE"]);
    assert.deepEqual(h.calls.map((c) => c.name), ["clean"], "only the clean-up step ran");
    assert.equal(h.runner.stop(), false, "nothing left to stop");
  });

  test("one scenario at a time; unknown scenarios are refused", async () => {
    const h = harness();
    h.runner.start("demo");
    assert.throws(() => h.runner.start("demo"), ConflictError);
    await h.runner.settled();
    assert.throws(() => h.runner.start("nope"), /Unknown scenario/);
  });
});

describe("scenario catalogue", () => {
  const ACTIONS = Object.keys(createActions({ client: {} }));
  for (const s of SCENARIOS) {
    test(`${s.id}: steps in time order, known actions, narration on every step, ends resolved as clean-up`, () => {
      assert.ok(s.steps.every((step, i) => i === 0 || step.at >= s.steps[i - 1].at));
      assert.ok(s.steps.every((step) => ACTIONS.includes(step.action)), "unknown action");
      assert.ok(s.steps.every((step) => typeof step.say === "string" && step.say.length > 10));
      const last = s.steps.at(-1);
      assert.deepEqual([last.action, last.params.status, last.cleanup], ["setStatus", "RESOLVED", true]);
    });
  }
});

describe("telemetryStatus", () => {
  test("reads the status from power-service's { telemetry: … } reply", () => {
    assert.equal(telemetryStatus({ telemetry: { status: "CRITICAL" } }), "CRITICAL");
    assert.equal(telemetryStatus(null), "reported");
  });
});

describe("createActions", () => {
  test("approvePlan waits for the plan to appear, then approves it", async () => {
    const clock = fakeClock();
    let polls = 0;
    const posted = [];
    const client = {
      get: async () => ({ plans: ++polls < 3 ? [] : [{ id: "p1", revision: 1, status: "PROPOSED" }] }),
      post: async (path, body) => { posted.push([path, body]); return { plan: { actions: [{ kind: "ambulance.dispatch" }, { kind: "notice" }] } }; },
    };
    const actions = createActions({ client, clock, pollMs: 2000 });
    const detail = await actions.approvePlan({ revision: 1 }, { disasterId: "d1" });
    assert.equal(polls, 3);
    assert.equal(posted[0][0], "/response/plans/p1/approve");
    assert.match(detail, /1 action\(s\) sent/);
  });

  test("approvePlan gives up after its timeout", async () => {
    const actions = createActions({ client: { get: async () => ({ plans: [] }) }, clock: fakeClock() });
    await assert.rejects(actions.approvePlan({ revision: 2, timeoutSeconds: 10 }, { disasterId: "d1" }), /no revision-2 plan within 10 s/);
  });

  test("a hospital surge is undone by hospitalRecover", async () => {
    const patched = [];
    const client = {
      get: async () => ({ hospitals: [{ id: "h1", name: "A", availableBeds: 50 }, { id: "h2", name: "B", availableBeds: 0 }, { id: "h3", name: "C", availableBeds: 20 }] }),
      patch: async (path, body) => patched.push([path, body.availableBeds]),
    };
    const actions = createActions({ client });
    const ctx = { disaster: { latitude: 1, longitude: 2, radiusKm: 15 }, hospitalBackup: [] };
    await actions.hospitalSurge({ count: 2, fraction: 0.6 }, ctx);
    await actions.hospitalRecover({}, ctx);
    assert.deepEqual(patched, [["/hospitals/h1/beds", 20], ["/hospitals/h3/beds", 8], ["/hospitals/h1/beds", 50], ["/hospitals/h3/beds", 20]]);
  });
});

describe("createGatewayClient", () => {
  function fakeGateway({ expireAfter = Infinity } = {}) {
    let logins = 0;
    let served = 0;
    const fetchImpl = async (url, opts) => {
      if (url.endsWith("/auth/login")) {
        logins++;
        return { ok: true, status: 200, json: async () => ({ accessToken: `t${logins}` }) };
      }
      served++;
      const stale = opts.headers.Authorization === "Bearer t1" && served > expireAfter;
      return stale
        ? { ok: false, status: 401, text: async () => JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "expired" } }) }
        : { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    };
    return { fetchImpl, logins: () => logins };
  }

  test("logs in on first use and again once when the token expires", async () => {
    const g = fakeGateway({ expireAfter: 1 });
    const client = createGatewayClient({ baseUrl: "http://gw/api/v1", email: "s@x", password: "p", fetchImpl: g.fetchImpl, log: {} });
    await client.get("/a");
    await client.get("/b"); // t1 expired → re-login → retry with t2
    assert.equal(g.logins(), 2);
  });

  test("background writes stop at their cap; scenario writes still go through", async () => {
    let now = 0;
    const g = fakeGateway();
    const client = createGatewayClient({ baseUrl: "http://gw", email: "s", password: "p", fetchImpl: g.fetchImpl, now: () => now, log: {} });
    for (let i = 0; i < AMBIENT_WRITE_CAP; i++) await client.post("/x", {}, { priority: "ambient" });
    await assert.rejects(client.post("/x", {}, { priority: "ambient" }), BudgetExceeded);
    await client.post("/x", {}, { priority: "scenario" }); // room kept for scenarios
    now += 61_000; // a minute later the window has moved on
    await client.post("/x", {}, { priority: "ambient" });
    assert.equal(client.budget().usedLastMinute, 1);
  });
});
