// Phase 14: unit tests for the shared messaging modules. They import a
// service's copy (copies.test.js proves the copies are identical), because the
// modules need that service's metrics.js and package.json.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const broker = await import("../../../services/disaster-service/src/broker.js");
const { createOutbox } = await import("../../../services/disaster-service/src/outbox.js");

const noSleep = async () => {};

describe("runWithRetries", () => {
  test("a handler that succeeds first time runs once", async () => {
    let calls = 0;
    const r = await broker.runWithRetries(async () => { calls++; }, {}, { sleep: noSleep });
    assert.deepEqual(r, { ok: true, attempts: 1 });
    assert.equal(calls, 1);
  });

  test("retries after each delay, then succeeds", async () => {
    let calls = 0;
    const slept = [];
    const r = await broker.runWithRetries(
      async () => { if (++calls < 3) throw new Error("db blip"); },
      {},
      { delaysMs: [10, 20, 40], sleep: async (ms) => slept.push(ms) }
    );
    assert.deepEqual(r, { ok: true, attempts: 3 });
    assert.deepEqual(slept, [10, 20]);
  });

  test("gives up after 1 + delays.length attempts and returns the last error", async () => {
    let calls = 0;
    const r = await broker.runWithRetries(async () => { calls++; throw new Error(`fail ${calls}`); }, {}, { delaysMs: [1, 1, 1], sleep: noSleep });
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 4);
    assert.equal(calls, 4);
    assert.equal(r.error.message, "fail 4");
  });

  test("the default schedule is 1 s, 2 s, 4 s", () => {
    assert.deepEqual(broker.RETRY_DELAYS_MS, [1000, 2000, 4000]);
  });
});

describe("parseEnvelope", () => {
  test("accepts a JSON object", () => {
    assert.deepEqual(broker.parseEnvelope(Buffer.from('{"eventId":"e1","payload":{}}')), { eventId: "e1", payload: {} });
  });
  for (const bad of ["not json", "null", "42", "[1,2]", '"text"']) {
    test(`rejects ${bad}`, () => assert.equal(broker.parseEnvelope(Buffer.from(bad)), null));
  }
});

describe("buildEnvelope", () => {
  test("has the canonical fields and this service as the source", () => {
    const e = broker.buildEnvelope("disaster.detected", { a: 1 }, "corr-1");
    assert.equal(e.eventType, "disaster.detected");
    assert.equal(e.sourceService, "disaster-service");
    assert.equal(e.correlationId, "corr-1");
    assert.deepEqual(e.payload, { a: 1 });
    assert.match(e.eventId, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(e.occurredAt)));
  });
  test("missing correlationId becomes null", () => {
    assert.equal(broker.buildEnvelope("x", {}).correlationId, null);
  });
});

describe("withTimeout", () => {
  test("passes a fast result through", async () => {
    assert.equal(await broker.withTimeout(Promise.resolve(7), 50, "slow"), 7);
  });
  test("rejects with the message when too slow", async () => {
    await assert.rejects(broker.withTimeout(new Promise(() => {}), 20, "no confirm"), /no confirm/);
  });
});

describe("publishEvent", () => {
  test("refuses when RabbitMQ isn't connected (the outbox keeps the row)", async () => {
    await assert.rejects(broker.publishEvent("disaster.detected", {}), /not connected/);
  });
});

describe("describeDeadLetter", () => {
  test("reports where a message came from and why, from the x-death header", () => {
    const envelope = { eventId: "ev-1", eventType: "disaster.detected", sourceService: "disaster-service", correlationId: "d-1", payload: {} };
    const msg = {
      content: Buffer.from(JSON.stringify(envelope)),
      fields: { routingKey: "disaster.detected" },
      properties: {
        messageId: "ev-1",
        headers: { "x-death": [{ queue: "q.hospital.disaster-events", reason: "rejected", count: 2, "routing-keys": ["disaster.detected"], time: 1760000000 }] },
      },
    };
    assert.deepEqual(broker.describeDeadLetter(msg), {
      eventId: "ev-1",
      eventType: "disaster.detected",
      routingKey: "disaster.detected",
      sourceService: "disaster-service",
      correlationId: "d-1",
      fromQueue: "q.hospital.disaster-events",
      reason: "rejected",
      deadLetteredTimes: 2,
      firstDeadLetteredAt: new Date(1760000000 * 1000).toISOString(),
      malformed: false,
    });
  });
  test("a malformed body is flagged, not thrown", () => {
    const d = broker.describeDeadLetter({ content: Buffer.from("{oops"), fields: { routingKey: "x.y" }, properties: { headers: {} } });
    assert.equal(d.malformed, true);
    assert.equal(d.routingKey, "x.y");
    assert.equal(d.fromQueue, null);
  });
});

// --- outbox -----------------------------------------------------------------

/** A tiny in-memory stand-in for pg: just enough SQL for the outbox. */
function fakePool() {
  const rows = [];
  const log = [];
  let nextId = 1;
  const query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    log.push(s.split(" ")[0]);
    if (s.startsWith("INSERT INTO outbox")) {
      rows.push({ id: nextId++, event_id: params[0], routing_key: params[1], envelope: params[2], published_at: null, attempts: 0, last_error: null });
      return { rows: [] };
    }
    if (s.startsWith("SELECT id, routing_key, envelope FROM outbox")) {
      return { rows: rows.filter((r) => !r.published_at).sort((a, b) => a.id - b.id).slice(0, params[0]) };
    }
    if (s.startsWith("UPDATE outbox SET published_at")) {
      const r = rows.find((x) => x.id === params[0]);
      r.published_at = new Date(); r.attempts++; r.last_error = null;
      return { rows: [] };
    }
    if (s.startsWith("UPDATE outbox SET attempts")) {
      const r = rows.find((x) => x.id === params[0]);
      r.attempts++; r.last_error = params[1];
      return { rows: [] };
    }
    return { rows: [] }; // BEGIN / COMMIT / ROLLBACK
  };
  return { rows, log, query, connect: async () => ({ query, release() {} }) };
}

describe("outbox", () => {
  test("enqueue stores the full envelope with the given client", async () => {
    const pool = fakePool();
    const outbox = createOutbox({ pool, publish: async () => {} });
    const env = await outbox.enqueue(pool, "disaster.detected", { disasterId: "d1" }, "d1");
    assert.equal(pool.rows.length, 1);
    assert.equal(pool.rows[0].event_id, env.eventId);
    assert.equal(pool.rows[0].routing_key, "disaster.detected");
    assert.deepEqual(JSON.parse(pool.rows[0].envelope), env);
  });

  test("relay sends unsent rows oldest first and marks them sent", async () => {
    const pool = fakePool();
    const sent = [];
    const outbox = createOutbox({ pool, publish: async (key, env) => sent.push([key, env.payload.n]) });
    for (let n = 1; n <= 3; n++) await outbox.enqueue(pool, `k${n}`, { n });
    assert.equal(await outbox.relayOnce(), 3);
    assert.deepEqual(sent, [["k1", 1], ["k2", 2], ["k3", 3]]);
    assert.ok(pool.rows.every((r) => r.published_at && r.attempts === 1));
    assert.equal(await outbox.relayOnce(), 0, "nothing is sent twice");
  });

  test("a failed publish stops the pass, keeps the row, and records the error", async () => {
    const pool = fakePool();
    let fail = true;
    const sent = [];
    const outbox = createOutbox({ pool, publish: async (key) => { if (fail && key === "k2") throw new Error("RabbitMQ is not connected"); sent.push(key); } });
    for (const k of ["k1", "k2", "k3"]) await outbox.enqueue(pool, k, {});
    assert.equal(await outbox.relayOnce(), 1);
    assert.deepEqual(sent, ["k1"], "k3 waits behind k2, keeping order");
    const k2 = pool.rows.find((r) => r.routing_key === "k2");
    assert.equal(k2.published_at, null);
    assert.equal(k2.attempts, 1);
    assert.match(k2.last_error, /not connected/);

    fail = false; // RabbitMQ is back
    assert.equal(await outbox.relayOnce(), 2);
    assert.deepEqual(sent, ["k1", "k2", "k3"]);
  });

  test("drain keeps going while full batches come back", async () => {
    const pool = fakePool();
    let count = 0;
    const outbox = createOutbox({ pool, publish: async () => { count++; }, batchSize: 2 });
    for (let i = 0; i < 5; i++) await outbox.enqueue(pool, "k", { i });
    await outbox.drain();
    assert.equal(count, 5);
    assert.ok(pool.rows.every((r) => r.published_at));
  });

  test("drain never throws (a broken database is logged, rows stay queued)", async () => {
    const errors = [];
    const pool = { connect: async () => { throw new Error("db down"); } };
    const outbox = createOutbox({ pool, publish: async () => {}, log: { error: (...a) => errors.push(a.join(" ")), warn() {} } });
    await outbox.drain();
    assert.match(errors[0], /db down/);
  });

  test("the relay claims rows with FOR UPDATE SKIP LOCKED (safe with several replicas)", async () => {
    let selectSql = "";
    const query = async (sql) => { if (sql.includes("FROM outbox")) selectSql = sql; return { rows: [] }; };
    const outbox = createOutbox({ pool: { connect: async () => ({ query, release() {} }) }, publish: async () => {} });
    await outbox.relayOnce();
    assert.match(selectSql.replace(/\s+/g, " "), /ORDER BY id LIMIT \$1 FOR UPDATE SKIP LOCKED/);
  });
});
