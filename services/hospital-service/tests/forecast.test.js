import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FORECAST_SETTINGS,
  toHourlySeries,
  holt,
  projectHolt,
  riskLevel,
  worstRisk,
  forecastOccupancy,
  forecastHospital,
} from "../src/services/forecast.js";
import { syntheticOccupancyPath } from "../src/db/seed.js";

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-10-25T12:00:00Z");

/** Hourly points for the last `hours` hours, oldest first, from f(hoursAgo). */
function hourly(hours, f) {
  const points = [];
  for (let k = hours; k >= 0; k--) points.push({ at: NOW - k * HOUR, pct: f(k) });
  return points;
}

describe("toHourlySeries", () => {
  test("carries the last value forward and ends exactly at now", () => {
    const series = toHourlySeries(
      [
        { at: NOW - 5 * HOUR, pct: 50 },
        { at: NOW - 2.5 * HOUR, pct: 60 },
      ],
      NOW - 10 * HOUR,
      NOW
    );
    assert.deepEqual(
      series.map((p) => p.pct),
      [50, 50, 50, 60, 60, 60]
    );
    assert.equal(series[series.length - 1].at, NOW);
  });

  test("a point before the window supplies the value at the window start", () => {
    const series = toHourlySeries([{ at: NOW - 100 * HOUR, pct: 42 }], NOW - 3 * HOUR, NOW);
    assert.deepEqual(
      series.map((p) => p.pct),
      [42, 42, 42, 42]
    );
  });

  test("no points gives an empty series", () => {
    assert.deepEqual(toHourlySeries([], NOW - HOUR, NOW), []);
  });
});

describe("holt", () => {
  test("follows a straight line exactly: the trend is its slope, the error zero", () => {
    const values = Array.from({ length: 30 }, (_, i) => 40 + i * 0.5);
    const model = holt(values, { alpha: 0.5, beta: 0.3, phi: 1 });
    assert.ok(Math.abs(model.trend - 0.5) < 1e-9);
    assert.ok(model.rmse < 1e-9);
    assert.ok(Math.abs(projectHolt(model, 4, 1) - (values[29] + 2)) < 1e-9);
  });

  test("damping keeps a long projection below the straight-line extrapolation", () => {
    const model = { level: 50, trend: 1 };
    assert.ok(projectHolt(model, 24, 0.9) < 50 + 24);
    assert.ok(projectHolt(model, 24, 0.9) > 50);
  });
});

describe("riskLevel", () => {
  const base = { thresholdPct: 90 };
  test("low and flat is LOW", () => assert.equal(riskLevel({ ...base, currentPct: 40, predictedPct: 45, hoursToThreshold: null }), "LOW"));
  test("75 %+ is MODERATE", () => assert.equal(riskLevel({ ...base, currentPct: 70, predictedPct: 80, hoursToThreshold: null }), "MODERATE"));
  test("crossing the line within the horizon is HIGH", () =>
    assert.equal(riskLevel({ ...base, currentPct: 80, predictedPct: 91, hoursToThreshold: 18 }), "HIGH"));
  test("full within 6 hours is CRITICAL", () => assert.equal(riskLevel({ ...base, currentPct: 88, predictedPct: 95, hoursToThreshold: 4 }), "CRITICAL"));
  test("97 %+ is CRITICAL", () => assert.equal(riskLevel({ ...base, currentPct: 97.5, predictedPct: 97.5, hoursToThreshold: 0 }), "CRITICAL"));
  test("worstRisk picks the highest", () => assert.equal(worstRisk("LOW", "HIGH", "MODERATE"), "HIGH"));
});

describe("forecastOccupancy", () => {
  test("a steady hospital stays flat with a narrow band and LOW risk", () => {
    const f = forecastOccupancy(hourly(48, () => 60), { nowMs: NOW, horizonHours: 24 });
    assert.equal(f.status, "OK");
    assert.equal(f.forecast.length, 24);
    assert.equal(f.predictedPct, 60);
    assert.equal(f.hoursToThreshold, null);
    assert.equal(f.risk, "LOW");
    assert.ok(f.forecast.every((p) => p.low <= p.pct && p.pct <= p.high));
  });

  // Phase 22: tuned on real occupancy, the forecast follows a trend's
  // direction but no longer projects it far (real occupancy mean-reverts;
  // extending trends tripled the error). See docs/PHASE-22-VALIDATION.md §3.
  test("a filling hospital: the forecast stays near the current level (no long trend extrapolation)", () => {
    // +0.6 % per hour for two days, now at 82 %.
    const f = forecastOccupancy(
      hourly(48, (k) => 82 - 0.6 * k),
      { nowMs: NOW, horizonHours: 24 }
    );
    assert.equal(f.currentPct, 82);
    assert.ok(f.trendPctPerHour > 0, `trend ${f.trendPctPerHour}`);
    // The smoothed level lags a steady rise a little, so the forecast can start
    // just under the latest reading; it never runs away from it.
    assert.ok(Math.abs(f.predictedPct - 82) < 2, `predicted ${f.predictedPct}`);
    assert.equal(f.hoursToThreshold, null, "82 % is not projected past 90 %");
    assert.equal(f.risk, "MODERATE");
  });

  test("an emptying hospital: likewise near the current level", () => {
    const f = forecastOccupancy(
      hourly(48, (k) => 50 + 0.5 * k),
      { nowMs: NOW, horizonHours: 12 }
    );
    assert.ok(f.trendPctPerHour < 0);
    assert.ok(Math.abs(f.predictedPct - 50) < 2, `predicted ${f.predictedPct}`);
  });

  test("the forecast never leaves 0–100 %", () => {
    const up = forecastOccupancy(
      hourly(48, (k) => 99 - 2 * k),
      { nowMs: NOW, horizonHours: 72 }
    );
    assert.ok(up.forecast.every((p) => p.pct <= 100 && p.high <= 100));
    const down = forecastOccupancy(
      hourly(48, (k) => 2 + 2 * k),
      { nowMs: NOW, horizonHours: 72 }
    );
    assert.ok(down.forecast.every((p) => p.pct >= 0 && p.low >= 0));
  });

  test("an already-full hospital has 0 hours to the line", () => {
    const f = forecastOccupancy(hourly(24, () => 97.5), { nowMs: NOW });
    assert.equal(f.hoursToThreshold, 0);
    assert.equal(f.risk, "CRITICAL");
  });

  test("fewer than the minimum hourly points is INSUFFICIENT_DATA with no forecast", () => {
    const f = forecastOccupancy(hourly(FORECAST_SETTINGS.minHourlyPoints - 2, () => 70), { nowMs: NOW });
    assert.equal(f.status, "INSUFFICIENT_DATA");
    assert.deepEqual(f.forecast, []);
    assert.equal(f.predictedPct, 70);
  });
});

describe("forecastHospital", () => {
  const hospital = {
    id: "h1",
    name: "Test Hospital",
    latitude: 18.5,
    longitude: 73.8,
    totalBeds: 100,
    availableBeds: 20,
    totalIcuBeds: 10,
    availableIcuBeds: 0,
  };

  test("forecasts beds and ICU from the history plus the live row, and counts backfilled points", () => {
    const history = [];
    for (let k = 24; k >= 1; k--) {
      history.push({ recordedAt: new Date(NOW - k * HOUR), totalBeds: 100, availableBeds: 20, totalIcuBeds: 10, availableIcuBeds: 0, source: k > 12 ? "backfill" : "live" });
    }
    const f = forecastHospital(hospital, history, { nowMs: NOW, horizonHours: 6 });
    assert.equal(f.hospitalId, "h1");
    assert.equal(f.historyPoints, 24);
    assert.equal(f.backfilledPoints, 12);
    assert.equal(f.beds.currentPct, 80);
    assert.equal(f.icu.currentPct, 100);
    assert.equal(f.icu.risk, "CRITICAL");
    assert.equal(f.risk, "CRITICAL"); // worst of the two
    assert.equal(f.beds.forecast.length, 6);
  });

  test("with no history at all it reports INSUFFICIENT_DATA from the live numbers", () => {
    const f = forecastHospital(hospital, [], { nowMs: NOW });
    assert.equal(f.beds.status, "INSUFFICIENT_DATA");
    assert.equal(f.beds.currentPct, 80);
  });
});

describe("syntheticOccupancyPath (demo backfill)", () => {
  test("is deterministic per hospital and stays within 0–100 %", () => {
    const a = syntheticOccupancyPath("Ruby Hall Clinic", 62, 72, "beds");
    const b = syntheticOccupancyPath("Ruby Hall Clinic", 62, 72, "beds");
    assert.deepEqual(a, b);
    assert.equal(a.length, 72);
    assert.ok(a.every((p) => p.pct >= 0 && p.pct <= 100));
  });

  test("a busy hospital's history rises towards now", () => {
    const path = syntheticOccupancyPath("Noble Hospital", 98, 72, "beds");
    assert.ok(path[path.length - 1].pct < path[0].pct + 5, "72 h ago should not be busier than 1 h ago");
  });
});
