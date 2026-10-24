/**
 * Phase 18: bed-occupancy forecast (docs/PHASE-18-MAPS-AND-FORECASTS.md §2).
 *
 * Pure functions, no I/O, like capacity.js. Input: a hospital's capacity
 * history (one point per change, from hospital_capacity_history). Output:
 * occupancy for the next N hours with an 80% band, the hours until it
 * crosses the "full" line, and a risk level.
 *
 * Method: the history is turned into an hourly series (the value in force
 * at each hour), then damped Holt linear exponential smoothing: a level
 * and a trend, both updated every hour, with the trend damped so a short
 * burst of admissions isn't extrapolated linearly for a whole day. The
 * band widens with the square root of the horizon from the one-step-ahead
 * error. Small and explainable on purpose: this is decision support for
 * operators, not a clinical model.
 */
import { calculateOccupancyPercentage } from "./capacity.js";

export const FORECAST_SETTINGS = Object.freeze({
  windowHours: 168, // history used: the last 7 days
  minHourlyPoints: 6, // fewer hourly points than this → INSUFFICIENT_DATA
  alpha: 0.5, // level smoothing
  beta: 0.3, // trend smoothing
  // Trend damping per hour. 0.9 capped any projected rise at 9 × the hourly
  // trend (a hospital filling 0.6 %/h for two days was projected +5 % for
  // the next day); 0.98 still flattens a short burst but follows a trend
  // that has held for days.
  phi: 0.98,
  // "Full": the line where capacity.js raises a CRITICAL alert (fewer
  // than 10% of beds free).
  thresholdPct: 90,
  bandZ: 1.28, // 80% prediction band
});

export const RISK_LEVELS = ["LOW", "MODERATE", "HIGH", "CRITICAL"];

const HOUR_MS = 3600 * 1000;

const round1 = (v) => Math.round(v * 10) / 10;
const clampPct = (v) => Math.min(100, Math.max(0, v));

/**
 * The value in force at each hour from `startMs` to `nowMs` (inclusive,
 * ending exactly at now), carrying the last known value forward.
 * points: [{ at: epoch ms, pct }] sorted ascending; a point before
 * startMs supplies the value at the start.
 */
export function toHourlySeries(points, startMs, nowMs) {
  if (points.length === 0 || nowMs < startMs) return [];
  const first = Math.max(startMs, points[0].at);
  const times = [];
  for (let t = nowMs; t >= first; t -= HOUR_MS) times.unshift(t);
  const series = [];
  let i = 0;
  let current = null;
  for (const t of times) {
    while (i < points.length && points[i].at <= t) current = points[i++].pct;
    if (current != null) series.push({ at: t, pct: current });
  }
  return series;
}

/** Damped Holt smoothing: final level/trend and the one-step-ahead RMSE. */
export function holt(values, { alpha, beta, phi }) {
  let level = values[0];
  let trend = values.length > 1 ? values[1] - values[0] : 0;
  let squaredErrors = 0;
  for (let i = 1; i < values.length; i++) {
    const predicted = level + phi * trend;
    squaredErrors += (values[i] - predicted) ** 2;
    const previousLevel = level;
    level = alpha * values[i] + (1 - alpha) * predicted;
    trend = beta * (level - previousLevel) + (1 - beta) * phi * trend;
  }
  const rmse = values.length > 1 ? Math.sqrt(squaredErrors / (values.length - 1)) : 0;
  return { level, trend, rmse };
}

/** Level + trend × (φ + φ² + … + φʰ). */
export function projectHolt({ level, trend }, h, phi) {
  let damp = 0;
  for (let i = 1; i <= h; i++) damp += phi ** i;
  return level + trend * damp;
}

export function riskLevel({ currentPct, predictedPct, hoursToThreshold, thresholdPct }) {
  const peak = Math.max(currentPct, predictedPct);
  if (peak >= 97 || (hoursToThreshold != null && hoursToThreshold <= 6)) return "CRITICAL";
  if (peak >= thresholdPct || hoursToThreshold != null) return "HIGH";
  if (peak >= 75) return "MODERATE";
  return "LOW";
}

export function worstRisk(...levels) {
  return levels.reduce((worst, l) => (RISK_LEVELS.indexOf(l) > RISK_LEVELS.indexOf(worst) ? l : worst), "LOW");
}

/**
 * Forecast of one occupancy series.
 * points: [{ at: epoch ms, pct }] ascending (pct = occupancy 0–100).
 */
export function forecastOccupancy(points, { nowMs, horizonHours = 24, ...overrides } = {}) {
  const s = { ...FORECAST_SETTINGS, ...overrides };
  const hourly = toHourlySeries(points, nowMs - s.windowHours * HOUR_MS, nowMs);
  const currentPct = hourly.length > 0 ? hourly[hourly.length - 1].pct : points.length > 0 ? points[points.length - 1].pct : 0;
  const history = hourly.map((p) => ({ at: new Date(p.at).toISOString(), pct: p.pct }));

  if (hourly.length < s.minHourlyPoints) {
    const hoursToThreshold = currentPct >= s.thresholdPct ? 0 : null;
    return {
      status: "INSUFFICIENT_DATA",
      currentPct,
      predictedPct: currentPct,
      trendPctPerHour: null,
      hoursToThreshold,
      thresholdPct: s.thresholdPct,
      risk: riskLevel({ currentPct, predictedPct: currentPct, hoursToThreshold, thresholdPct: s.thresholdPct }),
      history,
      forecast: [],
    };
  }

  const model = holt(
    hourly.map((p) => p.pct),
    s
  );
  const forecast = [];
  let hoursToThreshold = currentPct >= s.thresholdPct ? 0 : null;
  for (let h = 1; h <= horizonHours; h++) {
    const pct = clampPct(projectHolt(model, h, s.phi));
    const spread = s.bandZ * model.rmse * Math.sqrt(h);
    forecast.push({
      at: new Date(nowMs + h * HOUR_MS).toISOString(),
      pct: round1(pct),
      low: round1(clampPct(pct - spread)),
      high: round1(clampPct(pct + spread)),
    });
    if (hoursToThreshold == null && pct >= s.thresholdPct) hoursToThreshold = h;
  }
  const predictedPct = forecast[forecast.length - 1].pct;

  return {
    status: "OK",
    currentPct,
    predictedPct,
    trendPctPerHour: Math.round(model.trend * 100) / 100,
    hoursToThreshold,
    thresholdPct: s.thresholdPct,
    risk: riskLevel({ currentPct, predictedPct, hoursToThreshold, thresholdPct: s.thresholdPct }),
    history,
    forecast,
  };
}

/**
 * Both forecasts for one hospital from its capacity-history rows
 * ({ recordedAt, totalBeds, availableBeds, totalIcuBeds, availableIcuBeds,
 * source }, ascending). The current hospital row is appended as the final
 * point, so the forecast always starts from the live numbers.
 */
export function forecastHospital(hospital, historyRows, { nowMs = Date.now(), horizonHours = 24 } = {}) {
  const rows = [...historyRows, { ...hospital, recordedAt: new Date(nowMs), source: "live" }];
  const toPoints = (total, available) =>
    rows.map((r) => ({ at: new Date(r.recordedAt).getTime(), pct: calculateOccupancyPercentage(r[total], r[available]) }));
  const beds = forecastOccupancy(toPoints("totalBeds", "availableBeds"), { nowMs, horizonHours });
  const icu = forecastOccupancy(toPoints("totalIcuBeds", "availableIcuBeds"), { nowMs, horizonHours });
  return {
    hospitalId: hospital.id,
    hospitalName: hospital.name,
    latitude: hospital.latitude,
    longitude: hospital.longitude,
    generatedAt: new Date(nowMs).toISOString(),
    horizonHours,
    method: "Damped Holt linear exponential smoothing on hourly occupancy, last 7 days; 80% band",
    historyPoints: historyRows.length,
    backfilledPoints: historyRows.filter((r) => r.source === "backfill").length,
    risk: worstRisk(beds.risk, icu.risk),
    beds,
    icu,
  };
}
