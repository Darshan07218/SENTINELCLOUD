// Phase 12: disaster events from the bus are validated before use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { invalidDisasterPayload } from "../src/consumers/disasterConsumer.js";

const ok = { disasterId: "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b", latitude: 18.52, longitude: 73.85, radiusKm: 25 };

test("accepts a well-formed disaster payload (radius optional)", () => {
  assert.equal(invalidDisasterPayload(ok), null);
  const { radiusKm, ...noRadius } = ok;
  assert.equal(invalidDisasterPayload(noRadius), null);
});

test("rejects missing/forged fields and unbounded radius", () => {
  for (const [label, p] of [
    ["no payload", null],
    ["string payload", "x"],
    ["non-UUID id", { ...ok, disasterId: "'; DROP TABLE hospitals; --" }],
    ["latitude out of range", { ...ok, latitude: 123 }],
    ["latitude as string", { ...ok, latitude: "18.5" }],
    ["NaN longitude", { ...ok, longitude: Number.NaN }],
    ["huge radius", { ...ok, radiusKm: 20000 }],
    ["negative radius", { ...ok, radiusKm: -5 }],
  ]) {
    assert.ok(invalidDisasterPayload(p), label);
  }
});
