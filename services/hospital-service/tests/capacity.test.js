import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  calculateOccupancyPercentage,
  calculateHospitalCapacity,
  computeHospitalAlerts,
  haversineDistanceKm,
  boundingBoxForRadius,
} from "../src/services/capacity.js";

describe("calculateOccupancyPercentage", () => {
  test("0 available of 100 total is 100% occupied", () => {
    assert.equal(calculateOccupancyPercentage(100, 0), 100);
  });

  test("100 available of 100 total is 0% occupied", () => {
    assert.equal(calculateOccupancyPercentage(100, 100), 0);
  });

  test("50 available of 200 total is 75% occupied", () => {
    assert.equal(calculateOccupancyPercentage(200, 50), 75);
  });

  test("zero total beds is treated as 0% occupied, not NaN/Infinity", () => {
    assert.equal(calculateOccupancyPercentage(0, 0), 0);
  });

  test("rounds to one decimal place", () => {
    // 1 of 3 available -> 2/3 occupied -> 66.666...% -> 66.7
    assert.equal(calculateOccupancyPercentage(3, 1), 66.7);
  });
});

describe("calculateHospitalCapacity", () => {
  test("computes all three occupancy categories independently", () => {
    const capacity = calculateHospitalCapacity({
      totalBeds: 100,
      availableBeds: 20,
      totalIcuBeds: 10,
      availableIcuBeds: 10,
      totalVentilators: 5,
      availableVentilators: 0,
    });
    assert.equal(capacity.beds, 80);
    assert.equal(capacity.icuBeds, 0);
    assert.equal(capacity.ventilators, 100);
  });
});

describe("computeHospitalAlerts", () => {
  const healthyHospital = {
    name: "Healthy General",
    emergencyStatus: "NORMAL",
    totalBeds: 100,
    availableBeds: 50,
    totalIcuBeds: 10,
    availableIcuBeds: 5,
    totalVentilators: 10,
    availableVentilators: 5,
  };

  test("a healthy hospital has no alerts", () => {
    assert.deepEqual(computeHospitalAlerts(healthyHospital), []);
  });

  test("explicit OVERLOADED status always produces a CRITICAL alert", () => {
    const alerts = computeHospitalAlerts({ ...healthyHospital, emergencyStatus: "OVERLOADED" });
    assert.ok(alerts.some((a) => a.type === "OVERLOADED" && a.severity === "CRITICAL"));
  });

  test("bed availability below 10% produces a CRITICAL alert", () => {
    const alerts = computeHospitalAlerts({ ...healthyHospital, totalBeds: 100, availableBeds: 5 });
    assert.ok(alerts.some((a) => a.type === "LOW_BED_AVAILABILITY" && a.severity === "CRITICAL"));
  });

  test("bed availability between 10% and 25% produces a WARNING alert", () => {
    const alerts = computeHospitalAlerts({ ...healthyHospital, totalBeds: 100, availableBeds: 20 });
    assert.ok(alerts.some((a) => a.type === "LOW_BED_AVAILABILITY" && a.severity === "WARNING"));
  });

  test("bed availability at or above 25% produces no bed alert", () => {
    const alerts = computeHospitalAlerts({ ...healthyHospital, totalBeds: 100, availableBeds: 25 });
    assert.ok(!alerts.some((a) => a.type === "LOW_BED_AVAILABILITY"));
  });

  test("zero available ICU beds (with capacity > 0) produces a CRITICAL alert", () => {
    const alerts = computeHospitalAlerts({ ...healthyHospital, totalIcuBeds: 10, availableIcuBeds: 0 });
    assert.ok(alerts.some((a) => a.type === "NO_ICU_AVAILABLE" && a.severity === "CRITICAL"));
  });

  test("a hospital with zero total ICU beds does not trigger a false NO_ICU_AVAILABLE alert", () => {
    const alerts = computeHospitalAlerts({ ...healthyHospital, totalIcuBeds: 0, availableIcuBeds: 0 });
    assert.ok(!alerts.some((a) => a.type === "NO_ICU_AVAILABLE"));
  });

  test("zero available ventilators (with capacity > 0) produces a CRITICAL alert", () => {
    const alerts = computeHospitalAlerts({ ...healthyHospital, totalVentilators: 10, availableVentilators: 0 });
    assert.ok(alerts.some((a) => a.type === "NO_VENTILATORS_AVAILABLE" && a.severity === "CRITICAL"));
  });

  test("a critically overloaded hospital can produce multiple simultaneous alerts", () => {
    const alerts = computeHospitalAlerts({
      name: "Overwhelmed Hospital",
      emergencyStatus: "OVERLOADED",
      totalBeds: 100,
      availableBeds: 2,
      totalIcuBeds: 10,
      availableIcuBeds: 0,
      totalVentilators: 10,
      availableVentilators: 0,
    });
    const types = alerts.map((a) => a.type);
    assert.ok(types.includes("OVERLOADED"));
    assert.ok(types.includes("LOW_BED_AVAILABILITY"));
    assert.ok(types.includes("NO_ICU_AVAILABLE"));
    assert.ok(types.includes("NO_VENTILATORS_AVAILABLE"));
  });
});

describe("haversineDistanceKm", () => {
  test("distance from a point to itself is 0", () => {
    assert.equal(haversineDistanceKm(18.52, 73.85, 18.52, 73.85), 0);
  });

  test("known distance: Pune to Mumbai is roughly 120-150km", () => {
    // Pune: 18.5204,73.8567 ; Mumbai: 19.0760,72.8777
    const distance = haversineDistanceKm(18.5204, 73.8567, 19.076, 72.8777);
    assert.ok(distance > 100 && distance < 170, `expected ~120-150km, got ${distance}`);
  });
});

describe("boundingBoxForRadius", () => {
  test("returns a box that contains the center point", () => {
    const box = boundingBoxForRadius(18.52, 73.85, 25);
    assert.ok(18.52 >= box.minLat && 18.52 <= box.maxLat);
    assert.ok(73.85 >= box.minLng && 73.85 <= box.maxLng);
  });

  test("clamps latitude to valid range near the poles", () => {
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
