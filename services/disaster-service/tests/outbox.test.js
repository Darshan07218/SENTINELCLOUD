// Phase 14: with an outbox, a disaster change and its event are written in the
// same transaction (docs/PHASE-14-RELIABLE-EVENTS.md §2.1).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDisasterService } from "../src/services/disasterService.js";

const DISASTER = { id: "11111111-1111-1111-1111-111111111111", type: "FLOOD", severity: "HIGH", latitude: 18.52, longitude: 73.85, radiusKm: 15, description: "x", status: "ACTIVE", occurredAt: "2026-10-24T10:00:00.000Z" };

function harness({ setStatusResult = { ...DISASTER, status: "CONTAINED" } } = {}) {
  const log = [];
  const client = { name: "tx-client" };
  const repo = {
    create: async () => { log.push("create"); return DISASTER; },
    findById: async () => DISASTER,
    setStatus: async () => { log.push("setStatus"); return setStatusResult; },
  };
  const outbox = {
    enqueue: async (queryable, key, payload, correlationId) => { log.push(["enqueue", queryable.name, key, correlationId, payload.status]); },
    kick: () => log.push("kick"),
  };
  const transaction = async (fn) => {
    log.push("BEGIN");
    try {
      const r = await fn({ disasterRepository: repo, client });
      log.push("COMMIT");
      return r;
    } catch (err) {
      log.push("ROLLBACK");
      throw err;
    }
  };
  const service = createDisasterService({ disasterRepository: repo, publishEvent: async () => { throw new Error("must not publish directly"); }, outbox, transaction });
  return { service, log };
}

describe("disaster service with the outbox", () => {
  test("create: the disaster and disaster.detected are written in one transaction, then the relay is kicked", async () => {
    const { service, log } = harness();
    const r = await service.createDisaster({}, "user-1");
    assert.equal(r.eventPublished, true);
    assert.deepEqual(log, ["BEGIN", "create", ["enqueue", "tx-client", "disaster.detected", DISASTER.id, "ACTIVE"], "COMMIT", "kick"]);
  });

  test("status change: the event carries the new status and the disaster id as correlationId", async () => {
    const { service, log } = harness();
    await service.setStatus(DISASTER.id, "CONTAINED");
    assert.deepEqual(log.find((e) => Array.isArray(e)), ["enqueue", "tx-client", "disaster.updated", DISASTER.id, "CONTAINED"]);
  });

  test("a lost race writes no event, doesn't kick, and returns 409", async () => {
    const { service, log } = harness({ setStatusResult: null });
    await assert.rejects(service.setStatus(DISASTER.id, "CONTAINED"), (err) => err.statusCode === 409 && err.code === "CONCURRENT_UPDATE");
    assert.ok(!log.some((e) => Array.isArray(e)), "nothing enqueued");
    assert.ok(!log.includes("kick"));
  });

  test("if writing the event fails, the change rolls back with it", async () => {
    const log = [];
    const failing = createDisasterService({
      disasterRepository: { create: async () => DISASTER },
      outbox: { enqueue: async () => { throw new Error("outbox insert failed"); }, kick: () => log.push("kick") },
      transaction: async (fn) => { try { const r = await fn({ disasterRepository: { create: async () => DISASTER }, client: {} }); log.push("COMMIT"); return r; } catch (e) { log.push("ROLLBACK"); throw e; } },
    });
    await assert.rejects(failing.createDisaster({}, "u"), /outbox insert failed/);
    assert.ok(log.includes("ROLLBACK") && !log.includes("COMMIT") && !log.includes("kick"));
  });

  test("without an outbox (unit-test wiring) it still publishes directly", async () => {
    const published = [];
    const service = createDisasterService({ disasterRepository: { create: async () => DISASTER }, publishEvent: async (k, p, c) => published.push([k, c]) });
    const r = await service.createDisaster({}, "u");
    assert.equal(r.eventPublished, true);
    assert.deepEqual(published, [["disaster.detected", DISASTER.id]]);
  });
});
