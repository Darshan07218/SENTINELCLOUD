#!/usr/bin/env node
/**
 * Phase 22: backtest of the bed-occupancy forecast
 * (services/hospital-service/src/services/forecast.js) on REAL hospital data.
 *
 * Data: US Department of Health & Human Services, "COVID-19 Reported Patient
 * Impact and Hospital Capacity by State Timeseries" (healthdata.gov,
 * dataset g62h-syeh; US government work, public domain): daily inpatient
 * beds and beds used per state. No comparable public series exists for
 * Indian hospitals.
 *
 * The same Holt smoothing, damping, band and settings as the live forecast,
 * run on DAILY occupancy (the live system steps hourly; the public data is
 * daily, so here one step = one day). At every 7th day: fit on the previous
 * 168 steps, forecast 1, 7 and 14 steps ahead, compare with what happened.
 * Baseline: persistence ("tomorrow = today"), the standard naive forecast.
 *
 *   node tools/validation/backtest-occupancy.mjs [--write]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { holt, projectHolt, FORECAST_SETTINGS } from "../../services/hospital-service/src/services/forecast.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATES = ["MA", "CA", "TX", "NY", "FL", "IL"];
const FROM = "2021-01-01";
const TO = "2023-12-31";
const WINDOW = 168; // steps of history, as the live forecast (168 hourly points)
const HORIZONS = [1, 7, 14];
const ORIGIN_EVERY = 7;

async function series(state) {
  const qs = new URLSearchParams({
    $select: "date,inpatient_beds,inpatient_beds_used",
    $where: `state='${state}' AND date between '${FROM}T00:00:00' and '${TO}T00:00:00'`,
    $order: "date",
    $limit: "5000",
  });
  const res = await fetch(`https://healthdata.gov/resource/g62h-syeh.json?${qs}`, { headers: { "User-Agent": "SentinelCloud coursework backtest" } });
  if (!res.ok) throw new Error(`healthdata.gov HTTP ${res.status} for ${state}`);
  return (await res.json())
    .map((r) => ({ date: r.date.slice(0, 10), beds: Number(r.inpatient_beds), used: Number(r.inpatient_beds_used) }))
    .filter((r) => r.beds > 0 && r.used >= 0 && r.used <= r.beds)
    .map((r) => ({ date: r.date, pct: (r.used / r.beds) * 100 }));
}

function backtest(points) {
  const out = Object.fromEntries(HORIZONS.map((h) => [h, { holtAbs: [], persistAbs: [], inBand: 0, n: 0 }]));
  const maxH = Math.max(...HORIZONS);
  for (let t = WINDOW; t + maxH < points.length; t += ORIGIN_EVERY) {
    const history = points.slice(t - WINDOW, t).map((p) => p.pct);
    const model = holt(history, FORECAST_SETTINGS);
    const last = history[history.length - 1];
    for (const h of HORIZONS) {
      const actual = points[t - 1 + h].pct;
      const forecast = Math.min(100, Math.max(0, projectHolt(model, h, FORECAST_SETTINGS.phi)));
      const spread = FORECAST_SETTINGS.bandZ * model.rmse * Math.sqrt(h);
      const r = out[h];
      r.holtAbs.push(Math.abs(forecast - actual));
      r.persistAbs.push(Math.abs(last - actual));
      if (actual >= forecast - spread && actual <= forecast + spread) r.inBand++;
      r.n++;
    }
  }
  return out;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * --tune: pick alpha, beta, phi and the band's z on 2021–2022 ONLY, then score
 * them on 2023, a year the tuning never saw, against persistence. The score
 * that matters is the 2023 one.
 */
function evaluate(points, settings, { from, to }) {
  const abs = [];
  const persist = [];
  const residuals = Object.fromEntries(HORIZONS.map((h) => [h, []]));
  const maxH = Math.max(...HORIZONS);
  for (let t = WINDOW; t + maxH < points.length; t += ORIGIN_EVERY) {
    const originDate = points[t - 1].date;
    if (originDate < from || originDate > to) continue;
    const history = points.slice(t - WINDOW, t).map((p) => p.pct);
    const model = holt(history, settings);
    for (const h of HORIZONS) {
      const actual = points[t - 1 + h].pct;
      const base = settings.anchor ? { ...model, level: history[history.length - 1] } : model;
      const forecast = Math.min(100, Math.max(0, projectHolt(base, h, settings.phi)));
      abs.push(Math.abs(forecast - actual));
      persist.push(Math.abs(history[history.length - 1] - actual));
      residuals[h].push(Math.abs(forecast - actual) / Math.max(model.rmse * Math.sqrt(h), 1e-9));
    }
  }
  return { mae: mean(abs), maePersistence: mean(persist), residuals };
}

async function tune() {
  const all = {};
  for (const state of STATES) all[state] = await series(state);
  const TRAIN = { from: "2021-01-01", to: "2022-12-31" };
  const TEST = { from: "2023-01-01", to: "2023-12-31" };
  const pooled = (settings, range) => {
    const runs = STATES.map((s) => evaluate(all[s], settings, range));
    return { mae: mean(runs.map((r) => r.mae)), maePersistence: mean(runs.map((r) => r.maePersistence)), residuals: runs.flatMap((r) => Object.values(r.residuals).flat()) };
  };
  let best = null;
  // Two forms: plain Holt (forecast starts at the smoothed level) and
  // anchored (starts at the latest observation, adds the damped trend).
  for (const anchor of [false, true]) {
    for (const alpha of [0.2, 0.3, 0.5, 0.7, 0.9]) {
      for (const beta of [0, 0.02, 0.05, 0.1, 0.3]) {
        for (const phi of [0.5, 0.8, 0.9, 0.95, 0.98]) {
          const r = pooled({ alpha, beta, phi, anchor }, TRAIN);
          if (!best || r.mae < best.mae) best = { alpha, beta, phi, anchor, mae: r.mae };
        }
      }
    }
  }
  // The best of each form, both scored on 2023, so the choice of form is visible too.
  const bestOf = (anchor) => {
    let b = null;
    for (const alpha of [0.2, 0.3, 0.5, 0.7, 0.9]) for (const beta of [0, 0.02, 0.05, 0.1, 0.3]) for (const phi of [0.5, 0.8, 0.9, 0.95, 0.98]) {
      const r = pooled({ alpha, beta, phi, anchor }, TRAIN);
      if (!b || r.mae < b.mae) b = { alpha, beta, phi, anchor, mae: r.mae };
    }
    return { ...b, maeTrain: round2(b.mae), maeTest2023: round2(pooled(b, TEST).mae) };
  };
  const forms = { plain: bestOf(false), anchored: bestOf(true) };
  // Band: the z that covers 80 % of the training forecasts' scaled errors.
  const trainRes = pooled(best, TRAIN).residuals.sort((a, b) => a - b);
  const bandZ = Math.round(trainRes[Math.floor(trainRes.length * 0.8)] * 100) / 100;
  const tuned = { alpha: best.alpha, beta: best.beta, phi: best.phi, anchor: best.anchor, bandZ };
  // The Phase 18 settings, kept fixed here so the before/after stays on record.
  const PHASE18 = { alpha: 0.5, beta: 0.3, phi: 0.98, bandZ: 1.28 };
  const before = pooled(PHASE18, TEST);
  const after = pooled(tuned, TEST);
  const coverage = (settings) => {
    const res = pooled(settings, TEST).residuals;
    return round2(res.filter((x) => x <= settings.bandZ).length / res.length);
  };
  const result = {
    forms,
    trainedOn: TRAIN,
    testedOn: TEST,
    tuned,
    test2023: {
      maePhase18Settings: round2(before.mae),
      maeTunedSettings: round2(after.mae),
      maePersistence: round2(after.maePersistence),
      skillPhase18: round2(1 - before.mae / before.maePersistence),
      skillTuned: round2(1 - after.mae / after.maePersistence),
      bandCoveragePhase18: coverage(PHASE18),
      bandCoverageTuned: coverage(tuned),
    },
  };
  console.log(JSON.stringify(result, null, 1));
  if (process.argv.includes("--write")) {
    writeFileSync(path.join(HERE, "tuning-occupancy.json"), JSON.stringify({ generatedBy: "tools/validation/backtest-occupancy.mjs --tune", horizons: HORIZONS, ...result }, null, 2) + "\n");
    console.log("wrote tools/validation/tuning-occupancy.json");
  }
}

if (process.argv.includes("--tune")) {
  await tune();
  process.exit(0);
}

const perState = {};
const pooled = Object.fromEntries(HORIZONS.map((h) => [h, { holtAbs: [], persistAbs: [], inBand: 0, n: 0 }]));
for (const state of STATES) {
  const points = await series(state);
  const res = backtest(points);
  perState[state] = { days: points.length, from: points[0]?.date, to: points.at(-1)?.date };
  for (const h of HORIZONS) {
    perState[state][`h${h}`] = { maeHolt: round2(mean(res[h].holtAbs)), maePersistence: round2(mean(res[h].persistAbs)), bandCoverage: round2(res[h].inBand / res[h].n), origins: res[h].n };
    pooled[h].holtAbs.push(...res[h].holtAbs);
    pooled[h].persistAbs.push(...res[h].persistAbs);
    pooled[h].inBand += res[h].inBand;
    pooled[h].n += res[h].n;
  }
  console.log(`${state}: ${points.length} days ${points[0]?.date}..${points.at(-1)?.date}  ` + HORIZONS.map((h) => `h=${h}: MAE ${perState[state][`h${h}`].maeHolt} vs persistence ${perState[state][`h${h}`].maePersistence}, band ${Math.round(perState[state][`h${h}`].bandCoverage * 100)}%`).join(" | "));
}

const overall = Object.fromEntries(
  HORIZONS.map((h) => {
    const mh = mean(pooled[h].holtAbs);
    const mp = mean(pooled[h].persistAbs);
    return [`h${h}`, { maeHolt: round2(mh), maePersistence: round2(mp), skillVsPersistence: round2(1 - mh / mp), bandCoverage: round2(pooled[h].inBand / pooled[h].n), origins: pooled[h].n }];
  })
);
console.log("\nall states (MAE in occupancy percentage points; skill > 0 = better than persistence):");
for (const [h, r] of Object.entries(overall)) console.log(`  ${h}: Holt ${r.maeHolt} vs persistence ${r.maePersistence}  skill ${r.skillVsPersistence}  80% band covered ${Math.round(r.bandCoverage * 100)}%  (${r.origins} forecasts)`);

if (process.argv.includes("--write")) {
  writeFileSync(
    path.join(HERE, "backtest-occupancy.json"),
    JSON.stringify({ generatedBy: "tools/validation/backtest-occupancy.mjs", data: "healthdata.gov g62h-syeh (HHS, public domain), daily inpatient beds used / beds, " + STATES.join(", ") + `, ${FROM}..${TO}`, settings: { ...FORECAST_SETTINGS, window: WINDOW, originEvery: ORIGIN_EVERY, step: "1 day" }, overall, perState }, null, 2) + "\n"
  );
  console.log("wrote tools/validation/backtest-occupancy.json");
}
