// Phase 15: ambulance commands from response-service.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAmbulanceCommandHandlers, SYSTEM_USER_ID } from "../src/consumers/commandConsumer.js";

const CMD = "11111111-1111-1111-1111-111111111111";

function harness({ freeAmbulances = 10, alreadyCreated = 0 } = {}) {
  const emergencies = [];
  let free = freeAmbulances;
  for (let i = 0; i < alreadyCreated; i++) emergencies.push({ id: `pre-${i}`, sourceCommandId: CMD, assignedAmbulanceId: `amb-pre-${i}`, status: "ASSIGNED" });
  const emergencyRepository = {
    findByCommand: async (id) => emergencies.filter((e) => e.sourceCommandId === id),
    createForCommand: async (data, createdBy, sourceCommandId) => {
      const e = { id: randomUUID(), ...data, createdBy, sourceCommandId, assignedAmbulanceId: null, status: "ACTIVE" };
      emergencies.push(e);
      return e;
    },
  };
  const dispatchService = {
    dispatchForNewEmergency: async (e) => {
      if (free > 0) { free--; e.assignedAmbulanceId = `amb-${e.id}`; e.status = "ASSIGNED"; }
    },
    cancelEmergency: async (id) => {
      const e = emergencies.find((x) => x.id === id);
      if (!e) return null;
      if (e.status === "CANCELLED") throw Object.assign(new Error("closed"), { code: "EMERGENCY_ALREADY_CLOSED", statusCode: 409 });
      e.status = "CANCELLED";
      return e;
    },
  };
  const handlers = createAmbulanceCommandHandlers({ emergencyRepository, dispatchService });
  return { handlers, emergencies };
}

const dispatch = (overrides = {}) => ({ commandId: CMD, disasterId: "d1", latitude: 18.52, longitude: 73.85, count: 3, severity: "HIGH", description: "flood", ...overrides });

describe("command.ambulance.dispatch", () => {
  test("creates one emergency per unit, each dispatched, tagged with the command", async () => {
    const h = harness();
    const r = await h.handlers["command.ambulance.dispatch"](dispatch({ requestedBy: "22222222-2222-2222-2222-222222222222" }));
    assert.equal(r.dispatchedCount, 3);
    assert.equal(r.unassignedCount, 0);
    assert.equal(r.emergencyIds.length, 3);
    assert.ok(h.emergencies.every((e) => e.sourceCommandId === CMD && e.createdBy === "22222222-2222-2222-2222-222222222222"));
  });

  test("calls that find no free ambulance stay open and are reported", async () => {
    const h = harness({ freeAmbulances: 1 });
    const r = await h.handlers["command.ambulance.dispatch"](dispatch());
    assert.equal(r.dispatchedCount, 1);
    assert.equal(r.unassignedCount, 2);
  });

  test("a retry after a crash halfway only creates the missing calls", async () => {
    const h = harness({ alreadyCreated: 2 });
    const r = await h.handlers["command.ambulance.dispatch"](dispatch());
    assert.equal(h.emergencies.length, 3, "2 from before + 1 new");
    assert.equal(r.emergencyIds.length, 3);
  });

  test("no approver (auto mode) is recorded as the system user", async () => {
    const h = harness();
    await h.handlers["command.ambulance.dispatch"](dispatch({ count: 1 }));
    assert.equal(h.emergencies[0].createdBy, SYSTEM_USER_ID);
  });

  test("bad input is a command failure, not a retry", async () => {
    const h = harness();
    for (const bad of [{ count: 0 }, { count: 11 }, { latitude: 95 }]) {
      await assert.rejects(h.handlers["command.ambulance.dispatch"](dispatch(bad)), (err) => err.code === "INVALID_COMMAND");
    }
  });
});

describe("command.ambulance.stand-down (undo)", () => {
  test("cancels the calls; ones already closed or gone are reported, not errors", async () => {
    const h = harness();
    const { emergencyIds } = await h.handlers["command.ambulance.dispatch"](dispatch({ count: 2 }));
    h.emergencies[1].status = "CANCELLED";
    const r = await h.handlers["command.ambulance.stand-down"]({ commandId: "x", emergencyIds: [...emergencyIds, "33333333-3333-3333-3333-333333333333"] });
    assert.deepEqual(r.cancelled, [emergencyIds[0]]);
    assert.deepEqual(r.alreadyClosed.sort(), [emergencyIds[1], "33333333-3333-3333-3333-333333333333"].sort());
  });
});
