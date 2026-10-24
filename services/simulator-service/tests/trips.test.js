// Phase 16: ambulance trips and normal readings (pure logic).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nextTripStep, moveToward, haversineKm, kmPerTick, chooseHospital, SCENE_TICKS } from "../src/trips.js";
import { normalReading, NORMAL_LOAD, NORMAL_TEMP } from "../src/ambient.js";

const scene = { id: "e1", latitude: 18.52, longitude: 73.85, status: "ASSIGNED" };
const amb = (status, extra = {}) => ({ id: "a1", status, latitude: 18.55, longitude: 73.88, assignedEmergencyId: "e1", assignedHospitalId: null, ...extra });

describe("moveToward", () => {
  test("moves the given distance along the line and never overshoots", () => {
    const from = { latitude: 18.55, longitude: 73.88 };
    const total = haversineKm(18.55, 73.88, scene.latitude, scene.longitude);
    const m = moveToward(from, scene, 1);
    assert.equal(m.arrived, false);
    assert.ok(Math.abs(haversineKm(m.latitude, m.longitude, scene.latitude, scene.longitude) - (total - 1)) < 0.02);
    const last = moveToward(from, scene, total + 5);
    assert.deepEqual([last.latitude, last.longitude, last.arrived], [scene.latitude, scene.longitude, true]);
  });
  test("a 10 s tick at 8× is about 1.2 km", () => {
    assert.ok(Math.abs(kmPerTick(10) - 1.222) < 0.01);
  });
});

describe("nextTripStep", () => {
  test("DISPATCHED → set EN_ROUTE", () => {
    assert.deepEqual(nextTripStep({ ambulance: amb("DISPATCHED"), emergency: scene }), { type: "status", status: "EN_ROUTE" });
  });
  test("EN_ROUTE far away → move closer", () => {
    const s = nextTripStep({ ambulance: amb("EN_ROUTE"), emergency: scene });
    assert.equal(s.type, "move");
    assert.ok(haversineKm(s.latitude, s.longitude, scene.latitude, scene.longitude) < haversineKm(18.55, 73.88, scene.latitude, scene.longitude));
  });
  test("EN_ROUTE at the scene → AT_SCENE", () => {
    assert.deepEqual(nextTripStep({ ambulance: amb("EN_ROUTE", { latitude: 18.52, longitude: 73.85 }), emergency: scene }), { type: "status", status: "AT_SCENE" });
  });
  test("AT_SCENE waits, then chooses a hospital, then TRANSPORTING", () => {
    assert.equal(nextTripStep({ ambulance: amb("AT_SCENE"), emergency: scene, dwell: 0 }).type, "wait");
    assert.equal(nextTripStep({ ambulance: amb("AT_SCENE"), emergency: scene, dwell: SCENE_TICKS }).type, "chooseHospital");
    assert.deepEqual(nextTripStep({ ambulance: amb("AT_SCENE", { assignedHospitalId: "h1" }), emergency: scene, dwell: SCENE_TICKS }), { type: "status", status: "TRANSPORTING" });
  });
  test("TRANSPORTING drives to the hospital, then AT_HOSPITAL", () => {
    const hospital = { latitude: 18.50, longitude: 73.86 };
    assert.equal(nextTripStep({ ambulance: amb("TRANSPORTING", { assignedHospitalId: "h1", latitude: 18.52, longitude: 73.85 }), emergency: scene, hospital }).type, "move");
    assert.deepEqual(nextTripStep({ ambulance: amb("TRANSPORTING", { assignedHospitalId: "h1", ...hospital }), emergency: scene, hospital }), { type: "status", status: "AT_HOSPITAL" });
  });
  test("AT_HOSPITAL waits, then completes the call", () => {
    assert.equal(nextTripStep({ ambulance: amb("AT_HOSPITAL"), emergency: scene, dwell: 0 }).type, "wait");
    assert.deepEqual(nextTripStep({ ambulance: amb("AT_HOSPITAL"), emergency: scene, dwell: SCENE_TICKS }), { type: "complete", emergencyId: "e1" });
  });
  test("nothing to do: not on a call, or the call was closed elsewhere", () => {
    assert.equal(nextTripStep({ ambulance: { ...amb("AVAILABLE"), assignedEmergencyId: null }, emergency: null }), null);
    assert.equal(nextTripStep({ ambulance: amb("EN_ROUTE"), emergency: { ...scene, status: "CANCELLED" } }), null);
    assert.equal(nextTripStep({ ambulance: amb("EN_ROUTE"), emergency: null }), null);
  });
});

describe("chooseHospital", () => {
  test("nearest with free beds that isn't overloaded", () => {
    const hs = [
      { id: "full", latitude: 18.551, longitude: 73.881, availableBeds: 0 },
      { id: "over", latitude: 18.552, longitude: 73.882, availableBeds: 5, emergencyStatus: "OVERLOADED" },
      { id: "ok", latitude: 18.60, longitude: 73.90, availableBeds: 5, emergencyStatus: "NORMAL" },
    ];
    assert.equal(chooseHospital(hs, { latitude: 18.55, longitude: 73.88 }).id, "ok");
    assert.equal(chooseHospital(hs.slice(0, 2), { latitude: 18.55, longitude: 73.88 }).id, "over", "fallback: overloaded but has beds");
    assert.equal(chooseHospital([], { latitude: 0, longitude: 0 }), null);
  });
});

describe("normalReading", () => {
  const t = { ratedVoltageKv: 11, ratedCurrentAmps: 400 };
  test("stays inside the normal band, near rated voltage and current", () => {
    for (let i = 0; i < 200; i++) {
      const r = normalReading({ ...t, lastLoadPercentage: 60, lastTemperatureCelsius: 50 });
      assert.ok(r.loadPercentage >= NORMAL_LOAD[0] && r.loadPercentage <= NORMAL_LOAD[1]);
      assert.ok(r.temperatureCelsius >= NORMAL_TEMP[0] && r.temperatureCelsius <= NORMAL_TEMP[1]);
      assert.ok(Math.abs(r.voltage - 11) / 11 <= 0.005);
      assert.ok(Math.abs(r.currentAmps - 400) / 400 <= 0.007);
    }
  });
  test("readings fed back into themselves stay steady (no drift for the statistical check to flag)", () => {
    // Found on the cluster: a ±3 % random walk drifted load from 55 to 65,
    // which the power service flagged at 3–4 standard deviations.
    let last = { ...t, lastLoadPercentage: 55, lastTemperatureCelsius: 45 };
    const loads = [];
    for (let i = 0; i < 500; i++) {
      const r = normalReading(last);
      loads.push(r.loadPercentage);
      last = { ...t, lastLoadPercentage: r.loadPercentage, lastTemperatureCelsius: r.temperatureCelsius };
    }
    assert.ok(Math.min(...loads) >= 52 && Math.max(...loads) <= 58, `load wandered: ${Math.min(...loads)}..${Math.max(...loads)}`);
  });
  test("a transformer left hot is walked back down, not snapped", () => {
    const r = normalReading({ ...t, lastLoadPercentage: 125, lastTemperatureCelsius: 95 }, () => 0.5);
    assert.equal(r.loadPercentage, 115);
    assert.equal(r.temperatureCelsius, 87);
  });
});
