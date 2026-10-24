import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createHospitalSchema,
  updateHospitalSchema,
  updateBedsSchema,
  overloadSchema,
  nearQuerySchema,
} from "../src/schemas/hospitalSchemas.js";

const validHospital = {
  name: "Test General Hospital",
  address: "123 Main Street, Testville",
  latitude: 18.52,
  longitude: 73.85,
  emergencyContactName: "Dr. Test",
  emergencyContactPhone: "+91-20-1234-5678",
  totalBeds: 100,
  availableBeds: 40,
  totalIcuBeds: 10,
  availableIcuBeds: 3,
  totalVentilators: 5,
  availableVentilators: 2,
};

describe("createHospitalSchema", () => {
  test("accepts a valid hospital payload", () => {
    const result = createHospitalSchema.safeParse(validHospital);
    assert.equal(result.success, true);
  });

  test("rejects availableBeds greater than totalBeds", () => {
    const result = createHospitalSchema.safeParse({ ...validHospital, availableBeds: 150 });
    assert.equal(result.success, false);
    assert.ok(result.error.issues.some((i) => i.path.includes("availableBeds")));
  });

  test("rejects availableIcuBeds greater than totalIcuBeds", () => {
    const result = createHospitalSchema.safeParse({ ...validHospital, availableIcuBeds: 999 });
    assert.equal(result.success, false);
  });

  test("rejects availableVentilators greater than totalVentilators", () => {
    const result = createHospitalSchema.safeParse({ ...validHospital, availableVentilators: 999 });
    assert.equal(result.success, false);
  });

  test("rejects an out-of-range latitude", () => {
    const result = createHospitalSchema.safeParse({ ...validHospital, latitude: 200 });
    assert.equal(result.success, false);
  });

  test("rejects an out-of-range longitude", () => {
    const result = createHospitalSchema.safeParse({ ...validHospital, longitude: -200 });
    assert.equal(result.success, false);
  });

  test("rejects a negative bed count", () => {
    const result = createHospitalSchema.safeParse({ ...validHospital, totalBeds: -5 });
    assert.equal(result.success, false);
  });

  test("rejects a malformed phone number", () => {
    const result = createHospitalSchema.safeParse({ ...validHospital, emergencyContactPhone: "not a phone" });
    assert.equal(result.success, false);
  });

  test("rejects a too-short name", () => {
    const result = createHospitalSchema.safeParse({ ...validHospital, name: "A" });
    assert.equal(result.success, false);
  });
});

describe("updateHospitalSchema", () => {
  test("accepts a single-field partial update", () => {
    const result = updateHospitalSchema.safeParse({ name: "Renamed Hospital" });
    assert.equal(result.success, true);
  });

  test("rejects an empty object", () => {
    const result = updateHospitalSchema.safeParse({});
    assert.equal(result.success, false);
  });

  test("strips fields that aren't part of the profile shape (e.g. availableBeds)", () => {
    // availableBeds isn't part of this schema's shape at all, so Zod
    // silently omits it from the parsed output rather than erroring —
    // assert the field is gone from the parsed result, proving it
    // can't sneak through to the profile-update endpoint.
    const result = updateHospitalSchema.safeParse({ name: "X Hospital", availableBeds: 999 });
    assert.equal(result.success, true);
    assert.equal(result.data.availableBeds, undefined);
  });

  test("accepts a null managedByUserId (unclaiming a hospital)", () => {
    const result = updateHospitalSchema.safeParse({ managedByUserId: null });
    assert.equal(result.success, true);
  });
});

describe("updateBedsSchema", () => {
  test("accepts a valid non-negative integer", () => {
    assert.equal(updateBedsSchema.safeParse({ availableBeds: 12 }).success, true);
  });

  test("rejects a negative number", () => {
    assert.equal(updateBedsSchema.safeParse({ availableBeds: -1 }).success, false);
  });

  test("rejects a non-integer", () => {
    assert.equal(updateBedsSchema.safeParse({ availableBeds: 3.5 }).success, false);
  });
});

describe("overloadSchema", () => {
  test("accepts true/false", () => {
    assert.equal(overloadSchema.safeParse({ overloaded: true }).success, true);
    assert.equal(overloadSchema.safeParse({ overloaded: false }).success, true);
  });

  test("rejects a non-boolean", () => {
    assert.equal(overloadSchema.safeParse({ overloaded: "yes" }).success, false);
  });
});

describe("nearQuerySchema", () => {
  test("coerces string query params to numbers", () => {
    const result = nearQuerySchema.safeParse({ lat: "18.52", lng: "73.85", radiusKm: "10" });
    assert.equal(result.success, true);
    assert.equal(result.data.lat, 18.52);
    assert.equal(result.data.radiusKm, 10);
  });

  test("defaults radiusKm to 25 when omitted", () => {
    const result = nearQuerySchema.safeParse({ lat: "18.52", lng: "73.85" });
    assert.equal(result.success, true);
    assert.equal(result.data.radiusKm, 25);
  });

  test("rejects a missing lat", () => {
    const result = nearQuerySchema.safeParse({ lng: "73.85" });
    assert.equal(result.success, false);
  });

  test("rejects an unreasonable radius", () => {
    const result = nearQuerySchema.safeParse({ lat: "18.52", lng: "73.85", radiusKm: "10000" });
    assert.equal(result.success, false);
  });
});
