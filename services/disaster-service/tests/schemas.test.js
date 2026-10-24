import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createDisasterSchema, updateDisasterSchema, setStatusSchema, nearQuerySchema } from "../src/schemas/disasterSchemas.js";

const validDisaster = {
  type: "FLOOD",
  severity: "HIGH",
  latitude: 18.52,
  longitude: 73.85,
  radiusKm: 10,
  description: "Heavy monsoon flooding along the riverbank.",
};

describe("createDisasterSchema", () => {
  test("accepts a valid disaster payload", () => {
    const result = createDisasterSchema.safeParse(validDisaster);
    assert.equal(result.success, true);
  });

  test("rejects an unsupported disaster type", () => {
    const result = createDisasterSchema.safeParse({ ...validDisaster, type: "METEOR_STRIKE" });
    assert.equal(result.success, false);
  });

  test("rejects an unsupported severity", () => {
    const result = createDisasterSchema.safeParse({ ...validDisaster, severity: "EXTREME" });
    assert.equal(result.success, false);
  });

  test("rejects a non-positive radius", () => {
    const result = createDisasterSchema.safeParse({ ...validDisaster, radiusKm: 0 });
    assert.equal(result.success, false);
  });

  test("rejects a description that is too short", () => {
    const result = createDisasterSchema.safeParse({ ...validDisaster, description: "bad" });
    assert.equal(result.success, false);
  });

  test("rejects out-of-range coordinates", () => {
    const result = createDisasterSchema.safeParse({ ...validDisaster, latitude: 200 });
    assert.equal(result.success, false);
  });
});

describe("updateDisasterSchema", () => {
  test("accepts a partial update with just severity", () => {
    const result = updateDisasterSchema.safeParse({ severity: "CRITICAL" });
    assert.equal(result.success, true);
  });

  test("rejects an empty update body", () => {
    const result = updateDisasterSchema.safeParse({});
    assert.equal(result.success, false);
  });
});

describe("setStatusSchema", () => {
  test("accepts a valid status", () => {
    const result = setStatusSchema.safeParse({ status: "CONTAINED" });
    assert.equal(result.success, true);
  });

  test("rejects an invalid status", () => {
    const result = setStatusSchema.safeParse({ status: "ARCHIVED" });
    assert.equal(result.success, false);
  });
});

describe("nearQuerySchema", () => {
  test("coerces string query params into numbers", () => {
    const result = nearQuerySchema.safeParse({ lat: "18.5", lng: "73.8", radiusKm: "30" });
    assert.equal(result.success, true);
    assert.equal(result.data.lat, 18.5);
    assert.equal(result.data.radiusKm, 30);
  });

  test("defaults radiusKm when omitted", () => {
    const result = nearQuerySchema.safeParse({ lat: "18.5", lng: "73.8" });
    assert.equal(result.success, true);
    assert.equal(result.data.radiusKm, 50);
  });
});
