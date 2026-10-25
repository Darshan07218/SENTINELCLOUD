// Phase 20: the bed command handlers (the SQL is tested on real Postgres in tests/db).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHospitalCommandHandlers } from "../src/consumers/commandConsumer.js";
import { CommandError } from "../src/commands.js";
import { ReservationError } from "../src/services/reservations.js";

const HID = "11111111-1111-4111-8111-111111111111";

function fakeReservations({ reserveError, releaseResult } = {}) {
  const calls = [];
  return {
    calls,
    async reserve(args) {
      calls.push(["reserve", args]);
      if (reserveError) throw reserveError;
      return { reservation: { id: "r1", hospitalId: args.hospitalId, beds: Math.min(args.beds, 7), icuBeds: args.icuBeds }, hospitalName: "City Hospital" };
    },
    async release(id) {
      calls.push(["release", id]);
      return releaseResult ?? { reservation: { id, beds: 7, icuBeds: 2 }, alreadyReleased: false };
    },
  };
}

describe("hospital bed commands", () => {
  test("reserve passes the command through and reports what was actually held", async () => {
    const svc = fakeReservations();
    const h = createHospitalCommandHandlers({ reservationService: svc });
    const result = await h["command.hospital.reserve-beds"]({ commandId: "c1", planId: "p1", disasterId: "d1", hospitalId: HID, beds: 10, icuBeds: 2, notes: "plan" });
    assert.deepEqual(svc.calls[0][1], { hospitalId: HID, beds: 10, icuBeds: 2, disasterId: "d1", planId: "p1", commandId: "c1", notes: "plan" });
    assert.deepEqual(
      [result.reservationId, result.reservedBeds, result.reservedIcuBeds, result.requestedBeds, result.hospitalName],
      ["r1", 7, 2, 10, "City Hospital"]
    );
  });

  test("a business refusal (no free beds) becomes a command failure, not a retry", async () => {
    const h = createHospitalCommandHandlers({ reservationService: fakeReservations({ reserveError: new ReservationError("NO_CAPACITY", "full") }) });
    await assert.rejects(h["command.hospital.reserve-beds"]({ hospitalId: HID, beds: 1 }), (err) => err instanceof CommandError && err.code === "NO_CAPACITY");
  });

  test("a database error is NOT a command failure (it propagates, so the message is retried)", async () => {
    const dbDown = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const h = createHospitalCommandHandlers({ reservationService: fakeReservations({ reserveError: dbDown }) });
    await assert.rejects(h["command.hospital.reserve-beds"]({ hospitalId: HID, beds: 1 }), (err) => !(err instanceof CommandError));
  });

  test("release reports the beds given back, and a second release is harmless", async () => {
    const h = createHospitalCommandHandlers({ reservationService: fakeReservations() });
    const r = await h["command.hospital.release-beds"]({ reservationId: "r1" });
    assert.deepEqual([r.reservationId, r.releasedBeds, r.releasedIcuBeds, r.alreadyReleased], ["r1", 7, 2, false]);
    const again = createHospitalCommandHandlers({ reservationService: fakeReservations({ releaseResult: { reservation: { id: "r1", beds: 7, icuBeds: 2 }, alreadyReleased: true } }) });
    assert.equal((await again["command.hospital.release-beds"]({ reservationId: "r1" })).alreadyReleased, true);
  });
});
