import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { haversineDistanceKm, boundingBoxForRadius } from "../src/services/geo.js";

describe("haversineDistanceKm", () => {
  test("distance between identical points is zero", () => {
    assert.equal(haversineDistanceKm(18.52, 73.85, 18.52, 73.85), 0);
  });

  test("is symmetric", () => {
    const a = haversineDistanceKm(18.5236, 73.8737, 18.5308, 73.8794);
    const b = haversineDistanceKm(18.5308, 73.8794, 18.5236, 73.8737);
    assert.ok(Math.abs(a - b) < 0.0001);
  });
});

describe("boundingBoxForRadius", () => {
  test("contains the origin point", () => {
    const box = boundingBoxForRadius(18.52, 73.85, 10);
    assert.ok(18.52 >= box.minLat && 18.52 <= box.maxLat);
    assert.ok(73.85 >= box.minLng && 73.85 <= box.maxLng);
  });

  test("clamps to valid lat/lng range near the poles", () => {
    const box = boundingBoxForRadius(89.9, 0, 500);
    assert.ok(box.maxLat <= 90);
    assert.ok(box.minLat >= -90);
  });
});

describe("boundingBoxForRadius across the antimeridian (engineering review)", () => {
  test("a box that would cross ±180° widens to every longitude instead of clipping", () => {
    const box = boundingBoxForRadius(-17.7, 179.9, 50); // Fiji
    assert.equal(box.minLng, -180);
    assert.equal(box.maxLng, 180);
    // A point 30 km east, on the far side of the meridian, is inside.
    assert.ok(-179.85 >= box.minLng && -179.85 <= box.maxLng);
  });

  test("an ordinary box is not widened", () => {
    const box = boundingBoxForRadius(18.52, 73.85, 25);
    assert.ok(box.maxLng - box.minLng < 1);
  });
});
