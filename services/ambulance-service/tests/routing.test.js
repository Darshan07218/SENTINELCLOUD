import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  haversineDistanceKm,
  calculateRoadDistanceKm,
  calculateEstimatedResponseTimeMinutes,
  estimateRoute,
  boundingBoxForRadius,
} from "../src/services/routing.js";

describe("haversineDistanceKm", () => {
  test("distance from a point to itself is 0", () => {
    assert.equal(haversineDistanceKm(18.52, 73.85, 18.52, 73.85), 0);
  });

  test("known distance: Pune to Mumbai is roughly 120-170km straight-line", () => {
    const distance = haversineDistanceKm(18.5204, 73.8567, 19.076, 72.8777);
    assert.ok(distance > 100 && distance < 170, `expected ~120-150km, got ${distance}`);
  });
});

describe("calculateRoadDistanceKm", () => {
  test("is always greater than or equal to the straight-line distance", () => {
    const straight = haversineDistanceKm(18.52, 73.85, 18.6, 73.9);
    const road = calculateRoadDistanceKm(18.52, 73.85, 18.6, 73.9);
    assert.ok(road >= straight);
  });

  test("applies the documented ~1.3x road-distance factor", () => {
    const straight = haversineDistanceKm(18.52, 73.85, 18.6, 73.9);
    const road = calculateRoadDistanceKm(18.52, 73.85, 18.6, 73.9);
    assert.ok(Math.abs(road / straight - 1.3) < 0.01);
  });

  test("distance from a point to itself is still 0", () => {
    assert.equal(calculateRoadDistanceKm(18.52, 73.85, 18.52, 73.85), 0);
  });
});

describe("calculateEstimatedResponseTimeMinutes", () => {
  test("a zero-distance dispatch still takes at least the turnout time (~1.5 min)", () => {
    const eta = calculateEstimatedResponseTimeMinutes(0);
    assert.ok(eta >= 1.4 && eta <= 1.6, `expected ~1.5 min turnout-only, got ${eta}`);
  });

  test("longer distances produce longer ETAs, monotonically", () => {
    const eta5 = calculateEstimatedResponseTimeMinutes(5);
    const eta10 = calculateEstimatedResponseTimeMinutes(10);
    const eta20 = calculateEstimatedResponseTimeMinutes(20);
    assert.ok(eta5 < eta10);
    assert.ok(eta10 < eta20);
  });
});

describe("estimateRoute", () => {
  test("combines distance and ETA into one object", () => {
    const route = estimateRoute(18.52, 73.85, 18.6, 73.9);
    assert.ok(typeof route.distanceKm === "number");
    assert.ok(typeof route.etaMinutes === "number");
    assert.ok(route.distanceKm > 0);
    assert.ok(route.etaMinutes > 0);
  });

  test("zero distance still returns a positive ETA (turnout time)", () => {
    const route = estimateRoute(18.52, 73.85, 18.52, 73.85);
    assert.equal(route.distanceKm, 0);
    assert.ok(route.etaMinutes > 0);
  });
});

describe("boundingBoxForRadius", () => {
  test("returns a box that contains the center point", () => {
    const box = boundingBoxForRadius(18.52, 73.85, 25);
    assert.ok(18.52 >= box.minLat && 18.52 <= box.maxLat);
    assert.ok(73.85 >= box.minLng && 73.85 <= box.maxLng);
  });

  test("clamps latitude near the poles", () => {
    const box = boundingBoxForRadius(89.5, 0, 200);
    assert.ok(box.maxLat <= 90);
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
