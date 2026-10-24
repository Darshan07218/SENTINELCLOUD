import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const m = await import("../src/metrics.js");

function fakeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

describe("metrics: text format", () => {
  test("numbers are formatted like Micrometer (le=\"1.0\", not \"1\")", () => {
    assert.equal(m.formatNumber(1), "1.0");
    assert.equal(m.formatNumber(0.005), "0.005");
    assert.equal(m.formatNumber(2.5), "2.5");
    assert.equal(m.formatNumber(Infinity), "+Inf");
  });

  test("histogram buckets are cumulative and +Inf equals _count", async () => {
    const r = new m.Registry();
    const h = r.histogram("t_seconds", "test", ["route"], [0.1, 1]);
    h.observe({ route: "/a" }, 0.05);
    h.observe({ route: "/a" }, 0.5);
    h.observe({ route: "/a" }, 3);
    const text = await r.render();
    assert.match(text, /t_seconds_bucket\{route="\/a",le="0.1"\} 1/);
    assert.match(text, /t_seconds_bucket\{route="\/a",le="1.0"\} 2/);
    assert.match(text, /t_seconds_bucket\{route="\/a",le="\+Inf"\} 3/);
    assert.match(text, /t_seconds_count\{route="\/a"\} 3/);
    assert.match(text, /t_seconds_sum\{route="\/a"\} 3.55/);
    assert.match(text, /# TYPE t_seconds histogram/);
  });

  test("label values are escaped", async () => {
    const r = new m.Registry();
    r.counter("c_total", "test", ["v"]).inc({ v: 'a"b\\c\nd' });
    assert.match(await r.render(), /c_total\{v="a\\"b\\\\c\\nd"\} 1.0/);
  });

  test("unknown labels and negative counter increments are rejected", () => {
    const r = new m.Registry();
    const c = r.counter("x_total", "test", ["a"]);
    assert.throws(() => c.inc({ b: "1" }), /unknown label/);
    assert.throws(() => c.inc({ a: "1" }, -1), /only increase/);
  });

  test("a failing collector does not break the rest of the scrape", async () => {
    const r = new m.Registry();
    r.gauge("bad", "test", [], { collect: async () => { throw new Error("boom"); } });
    r.counter("good_total", "test").inc();
    const text = await r.render();
    assert.match(text, /collector for bad failed: boom/);
    assert.match(text, /good_total 1.0/);
  });
});

describe("metrics: HTTP instrumentation", () => {
  test("uriTemplate uses the route template, never the raw path", () => {
    assert.equal(m.uriTemplate({ baseUrl: "", route: { path: "/hospitals/:id" } }, fakeRes()), "/hospitals/:id");
    assert.equal(m.uriTemplate({ baseUrl: "/emergencies", route: { path: "/" } }, fakeRes()), "/emergencies");
    assert.equal(m.uriTemplate({ baseUrl: "/api/v1/hospitals" }, fakeRes()), "/api/v1/hospitals/**");
    assert.equal(m.uriTemplate({ baseUrl: "" }, fakeRes(404)), "NOT_FOUND");
  });

  test("outcome matches Micrometer's tag values", () => {
    assert.equal(m.outcomeFor(201), "SUCCESS");
    assert.equal(m.outcomeFor(404), "CLIENT_ERROR");
    assert.equal(m.outcomeFor(503), "SERVER_ERROR");
  });

  test("middleware records one observation per finished request", async () => {
    const req = { path: "/hospitals/7", method: "GET", baseUrl: "", route: { path: "/hospitals/:id" } };
    const res = fakeRes(503);
    await new Promise((resolve) => m.metricsMiddleware(req, res, resolve));
    res.emit("finish");
    const text = await m.registry.render();
    assert.match(text, /http_server_requests_seconds_count\{method="GET",uri="\/hospitals\/:id",status="503",outcome="SERVER_ERROR"\} 1/);
  });

  test("/metrics itself is not recorded", async () => {
    const res = fakeRes(200);
    await new Promise((resolve) => m.metricsMiddleware({ path: "/metrics", method: "GET" }, res, resolve));
    res.emit("finish");
    assert.doesNotMatch(await m.registry.render(), /uri="\/metrics"/);
  });
});

describe("metrics: events and dependencies", () => {
  test("event latency is measured from the envelope's occurredAt", async () => {
    m.recordEventConsumed({
      queue: "q.test",
      eventType: "disaster.detected",
      occurredAt: new Date(Date.now() - 1500).toISOString(),
      outcome: "success",
      handlerSeconds: 0.02,
    });
    const text = await m.registry.render();
    // 1.5s old → not in the ≤1s bucket, but in the ≤2.5s bucket
    assert.match(text, /sentinel_event_processing_seconds_bucket\{queue="q.test",event_type="disaster.detected",outcome="success",le="1.0"\} 0/);
    assert.match(text, /sentinel_event_processing_seconds_bucket\{queue="q.test",event_type="disaster.detected",outcome="success",le="2.5"\} 1/);
    assert.match(text, /sentinel_events_consumed_total\{queue="q.test",event_type="disaster.detected",outcome="success"\} 1.0/);
  });

  test("dependency checks: true → 1, false/throw/hang → 0", async () => {
    m.registerDependencyCheck("ok", async () => true);
    m.registerDependencyCheck("down", async () => false);
    m.registerDependencyCheck("throws", async () => { throw new Error("x"); });
    m.registerDependencyCheck("hangs", () => new Promise(() => {}));
    const text = await m.registry.render();
    assert.match(text, /sentinel_dependency_up\{dependency="ok"\} 1.0/);
    assert.match(text, /sentinel_dependency_up\{dependency="down"\} 0.0/);
    assert.match(text, /sentinel_dependency_up\{dependency="throws"\} 0.0/);
    assert.match(text, /sentinel_dependency_up\{dependency="hangs"\} 0.0/);
  });

  test("process metrics are present", async () => {
    const text = await m.registry.render();
    assert.match(text, /^process_cpu_seconds_total \d/m);
    assert.match(text, /^process_resident_memory_bytes \d/m);
    assert.match(text, /^nodejs_eventloop_lag_p99_seconds \d/m);
  });
});
