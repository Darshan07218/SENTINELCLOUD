import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createAmbulanceSchema,
  updateStatusSchema,
  dispatchSchema,
  nearestQuerySchema,
} from "../src/schemas/ambulanceSchemas.js";
import { createEmergencySchema } from "../src/schemas/emergencySchemas.js";

const validAmbulance = {
  vehicleNumber: "MH12-XY-9999",
  latitude: 18.52,
  longitude: 73.85,
  driverName: "Test Driver",
  driverPhone: "+91-98765-43210",
};

describe("createAmbulanceSchema", () => {
  test("accepts a valid payload and defaults equipmentLevel to BASIC", () => {
    const result = createAmbulanceSchema.safeParse(validAmbulance);
    assert.equal(result.success, true);
    assert.equal(result.data.equipmentLevel, "BASIC");
  });

  test("accepts an explicit equipmentLevel", () => {
    const result = createAmbulanceSchema.safeParse({ ...validAmbulance, equipmentLevel: "CRITICAL_CARE" });
    assert.equal(result.success, true);
    assert.equal(result.data.equipmentLevel, "CRITICAL_CARE");
  });

  test("rejects an invalid equipmentLevel", () => {
    const result = createAmbulanceSchema.safeParse({ ...validAmbulance, equipmentLevel: "SUPER_ADVANCED" });
    assert.equal(result.success, false);
  });

  test("rejects a malformed phone number", () => {
    const result = createAmbulanceSchema.safeParse({ ...validAmbulance, driverPhone: "call me maybe" });
    assert.equal(result.success, false);
  });

  test("rejects an out-of-range latitude", () => {
    const result = createAmbulanceSchema.safeParse({ ...validAmbulance, latitude: 999 });
    assert.equal(result.success, false);
  });
});

describe("updateStatusSchema", () => {
  test("accepts every valid status", () => {
    for (const status of ["AVAILABLE", "DISPATCHED", "EN_ROUTE", "AT_SCENE", "TRANSPORTING", "AT_HOSPITAL", "OUT_OF_SERVICE"]) {
      assert.equal(updateStatusSchema.safeParse({ status }).success, true, status);
    }
  });

  test("rejects an unknown status", () => {
    assert.equal(updateStatusSchema.safeParse({ status: "ON_BREAK" }).success, false);
  });
});

describe("dispatchSchema", () => {
  test("requires a valid UUID emergencyId", () => {
    assert.equal(dispatchSchema.safeParse({ emergencyId: "not-a-uuid" }).success, false);
    assert.equal(dispatchSchema.safeParse({ emergencyId: "11111111-1111-1111-1111-111111111111" }).success, true);
  });
});

describe("nearestQuerySchema", () => {
  test("defaults radiusKm to 50 and limit to 5", () => {
    const result = nearestQuerySchema.safeParse({ lat: "18.52", lng: "73.85" });
    assert.equal(result.success, true);
    assert.equal(result.data.radiusKm, 50);
    assert.equal(result.data.limit, 5);
  });

  test("caps limit at 20", () => {
    const result = nearestQuerySchema.safeParse({ lat: "18.52", lng: "73.85", limit: "9999" });
    assert.equal(result.success, false);
  });
});

describe("createEmergencySchema", () => {
  test("accepts a valid payload and defaults severity to MEDIUM", () => {
    const result = createEmergencySchema.safeParse({
      description: "Person collapsed on Main Street",
      latitude: 18.52,
      longitude: 73.85,
    });
    assert.equal(result.success, true);
    assert.equal(result.data.severity, "MEDIUM");
  });

  test("rejects a too-short description", () => {
    const result = createEmergencySchema.safeParse({ description: "hi", latitude: 18.52, longitude: 73.85 });
    assert.equal(result.success, false);
  });

  test("rejects an invalid severity", () => {
    const result = createEmergencySchema.safeParse({
      description: "Valid description here",
      latitude: 18.52,
      longitude: 73.85,
      severity: "APOCALYPTIC",
    });
    assert.equal(result.success, false);
  });
});
