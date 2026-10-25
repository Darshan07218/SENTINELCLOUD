// Phase 15: the engine's pure helpers. The full plan lifecycle on a real
// database is covered by tests/db/realPostgres.test.js.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { currentReactions, deliveredBy, commandFor, undoCommandFor, invalidDisaster, SYSTEM_USER_ID } from "../src/services/responseService.js";

const D = { id: "11111111-1111-1111-1111-111111111111", type: "FLOOD", severity: "HIGH", latitude: 18.52, longitude: 73.85, radiusKm: 15, description: "river" };
const plan = { id: "22222222-2222-2222-2222-222222222222", disaster: D };

describe("currentReactions", () => {
  test("keeps only reactions for the disaster's current radius (after an escalation, old ones don't count)", () => {
    const ctx = {
      radiusKm: 30,
      reactions: {
        "hospital.capacity.updated": { payload: { searchRadiusKm: 30, n: "new" } },
        "ambulance.status.updated": { payload: { searchRadiusKm: 15, n: "old" } },
        "something.else": { payload: { searchRadiusKm: 30 } },
      },
    };
    assert.deepEqual(currentReactions(ctx), { hospital: { searchRadiusKm: 30, n: "new" } });
  });
});

describe("deliveredBy", () => {
  test("counts what actually succeeded", () => {
    const delivered = deliveredBy({
      actions: [
        { kind: "ambulance.dispatch", status: "SUCCEEDED", result: { dispatchedCount: 2 } },
        { kind: "ambulance.dispatch", status: "FAILED", result: null },
        { kind: "blood.reserve", status: "SUCCEEDED", params: { bloodType: "O-", units: 4 } },
        { kind: "blood.reserve", status: "FAILED", params: { bloodType: "O+", units: 4, bloodBankId: "b1" } },
        // Phase 20: beds count what the hospital actually held, not what was asked.
        { kind: "hospital.reserve_beds", status: "SUCCEEDED", params: { hospitalId: "h1", beds: 30, icuBeds: 5 }, result: { reservedBeds: 24, reservedIcuBeds: 5 } },
        { kind: "hospital.reserve_beds", status: "FAILED", params: { hospitalId: "h2", beds: 10, icuBeds: 0 } },
      ],
    });
    assert.deepEqual(delivered, { ambulances: 2, bloodUnits: { "O-": 4 }, failedBloodBanks: { "O+": ["b1"] }, beds: 24, icuBeds: 5, failedHospitals: ["h2"] });
  });
});

describe("commandFor", () => {
  test("dispatch carries the disaster's location, the count and the approver", () => {
    const c = commandFor({ kind: "ambulance.dispatch", params: { count: 3 } }, plan, "33333333-3333-3333-3333-333333333333");
    assert.equal(c.routingKey, "command.ambulance.dispatch");
    assert.match(c.payload.commandId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      { planId: c.payload.planId, disasterId: c.payload.disasterId, lat: c.payload.latitude, count: c.payload.count, by: c.payload.requestedBy },
      { planId: plan.id, disasterId: D.id, lat: 18.52, count: 3, by: "33333333-3333-3333-3333-333333333333" }
    );
  });
  test("blood reservation and escalation", () => {
    const b = commandFor({ kind: "blood.reserve", params: { bloodBankId: "b", bloodType: "O-", units: 4, hospitalId: "h" } }, plan, SYSTEM_USER_ID);
    assert.equal(b.routingKey, "command.blood.reserve");
    assert.deepEqual([b.payload.bloodBankId, b.payload.bloodType, b.payload.units, b.payload.hospitalId], ["b", "O-", 4, "h"]);
    const w = commandFor({ kind: "disaster.widen_radius", params: { radiusKm: 30 } }, plan, SYSTEM_USER_ID);
    assert.deepEqual([w.routingKey, w.payload.disasterId, w.payload.radiusKm], ["command.disaster.widen-radius", D.id, 30]);
  });
  test("bed reservation (Phase 20) names the hospital, the beds and the disaster", () => {
    const c = commandFor({ kind: "hospital.reserve_beds", params: { hospitalId: "h", beds: 12, icuBeds: 3 } }, plan, SYSTEM_USER_ID);
    assert.equal(c.routingKey, "command.hospital.reserve-beds");
    assert.deepEqual([c.payload.hospitalId, c.payload.beds, c.payload.icuBeds, c.payload.disasterId, c.payload.planId], ["h", 12, 3, D.id, plan.id]);
  });
  test("a notice has no command; every command gets a fresh id", () => {
    assert.equal(commandFor({ kind: "notice", params: {} }, plan, SYSTEM_USER_ID), null);
    const a = commandFor({ kind: "ambulance.dispatch", params: { count: 1 } }, plan, SYSTEM_USER_ID);
    const b = commandFor({ kind: "ambulance.dispatch", params: { count: 1 } }, plan, SYSTEM_USER_ID);
    assert.notEqual(a.payload.commandId, b.payload.commandId);
  });
});

describe("undoCommandFor", () => {
  test("dispatch → stand down its emergencies; reservation → release it; escalation → nothing", () => {
    const sd = undoCommandFor({ kind: "ambulance.dispatch", result: { emergencyIds: ["e1", "e2"] } }, plan);
    assert.deepEqual([sd.routingKey, sd.payload.emergencyIds], ["command.ambulance.stand-down", ["e1", "e2"]]);
    const rel = undoCommandFor({ kind: "blood.reserve", result: { reservationId: "r1" } }, plan);
    assert.deepEqual([rel.routingKey, rel.payload.reservationId], ["command.blood.release", "r1"]);
    const beds = undoCommandFor({ kind: "hospital.reserve_beds", result: { reservationId: "hr1" } }, plan);
    assert.deepEqual([beds.routingKey, beds.payload.reservationId], ["command.hospital.release-beds", "hr1"]);
    assert.equal(undoCommandFor({ kind: "disaster.widen_radius", result: {} }, plan), null);
    assert.equal(undoCommandFor({ kind: "ambulance.dispatch", result: { emergencyIds: [] } }, plan), null, "nothing was created");
  });
});

describe("invalidDisaster", () => {
  const ok = { disasterId: D.id, type: "FLOOD", severity: "HIGH", status: "ACTIVE", latitude: 1, longitude: 2, radiusKm: 15 };
  test("accepts a real disaster payload", () => assert.equal(invalidDisaster(ok), null));
  for (const [field, value] of [["disasterId", "x"], ["type", "METEOR"], ["latitude", 91], ["radiusKm", 0], ["radiusKm", 501], ["status", "OPEN"]]) {
    test(`rejects ${field}=${value}`, () => assert.ok(invalidDisaster({ ...ok, [field]: value })));
  }
});
