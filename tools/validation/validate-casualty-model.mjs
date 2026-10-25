#!/usr/bin/env node
/**
 * Phase 22: the casualty model (services/response-service/src/impact.js)
 * against historical Indian disasters (tools/validation/events.json).
 *
 * For each event: the model's estimated casualties from the population in
 * the event's circle (WorldPop 2020, scaled to the event's year) and the
 * fixed input rules, against reported deaths + injuries. Reports the ratio
 * and the error on a log scale, because the events span 70 to 560,000
 * casualties.
 *
 *   node tools/validation/validate-casualty-model.mjs          # print the table
 *   node tools/validation/validate-casualty-model.mjs --write  # also write results.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { casualtiesFor } from "../../services/response-service/src/impact.js";
import { eventInputs, populationAtEvent } from "./model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function validate(doc = JSON.parse(readFileSync(path.join(HERE, "events.json"), "utf8"))) {
  const rows = doc.events.map((ev) => {
    const { severity, radiusKm } = eventInputs(ev);
    const population = populationAtEvent(ev, doc.indiaPopulationMillions);
    const { casualties: predicted } = casualtiesFor({ type: ev.type, severity, population });
    const observed = ev.observed.deaths + ev.observed.injured;
    const ratio = predicted / observed;
    return {
      id: ev.id,
      name: ev.name,
      type: ev.type,
      severity,
      radiusKm,
      populationInModel: population,
      predicted,
      observed,
      observedIsLowerBound: !ev.observed.injuriesReported,
      ratio: Math.round(ratio * 100) / 100,
      log10Error: Math.round(Math.log10(Math.max(predicted, 1) / observed) * 100) / 100,
    };
  });

  // Headline metrics over the events whose observed figure is complete.
  const complete = rows.filter((r) => !r.observedIsLowerBound);
  const abs = complete.map((r) => Math.abs(r.log10Error)).sort((a, b) => a - b);
  const median = abs.length % 2 ? abs[(abs.length - 1) / 2] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2;
  const within = (f) => complete.filter((r) => r.ratio >= 1 / f && r.ratio <= f).length;
  const underPredicted = complete.filter((r) => r.ratio < 1).length;
  const summary = {
    eventsWithCompleteFigures: complete.length,
    medianAbsLog10Error: Math.round(median * 100) / 100,
    medianFactorOff: Math.round(10 ** median * 10) / 10,
    withinFactor3: within(3),
    withinFactor10: within(10),
    underPredicted,
    overPredicted: complete.length - underPredicted,
    lowerBoundEvents: rows.length - complete.length,
    lowerBoundEventsPredictedAtLeastObserved: rows.filter((r) => r.observedIsLowerBound && r.predicted >= r.observed).length,
  };
  return { rows, summary };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}` || process.argv[1]?.endsWith("validate-casualty-model.mjs")) {
  const { rows, summary } = validate();
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("event", 40) + pad("type", 20) + pad("sev", 9) + pad("r km", 7) + pad("population", 13) + pad("predicted", 11) + pad("observed", 11) + "ratio");
  for (const r of rows) {
    console.log(pad(r.name.slice(0, 39), 40) + pad(r.type, 20) + pad(r.severity, 9) + pad(r.radiusKm, 7) + pad(r.populationInModel.toLocaleString("en-IN"), 13) + pad(r.predicted.toLocaleString("en-IN"), 11) + pad((r.observedIsLowerBound ? "≥" : "") + r.observed.toLocaleString("en-IN"), 11) + r.ratio);
  }
  console.log("\n" + JSON.stringify(summary, null, 1));
  if (process.argv.includes("--write")) {
    writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ generatedBy: "tools/validation/validate-casualty-model.mjs", summary, rows }, null, 2) + "\n");
    console.log("wrote tools/validation/results.json");
    // What the live system tells operators: per type, how far actual
    // casualties exceeded the estimate in the past (events with complete figures).
    const record = (rs) => {
      const under = rs.map((r) => r.observed / Math.max(r.predicted, 1)).sort((a, b) => a - b);
      return { events: rs.length, actualOverEstimateMin: Math.round(under[0] * 10) / 10, actualOverEstimateMax: Math.round(under[under.length - 1] * 10) / 10 };
    };
    const completeRows = rows.filter((r) => !r.observedIsLowerBound);
    const byType = {};
    for (const t of [...new Set(completeRows.map((r) => r.type))]) byType[t] = record(completeRows.filter((r) => r.type === t));
    const live = {
      generatedBy: "tools/validation/validate-casualty-model.mjs --write (docs/PHASE-22-VALIDATION.md)",
      note: "Actual casualties divided by the model's estimate, over historical Indian disasters with complete reported figures. Above 1 means the model under-estimated.",
      overall: { ...record(completeRows), medianFactorLow: summary.medianFactorOff },
      byType,
      typesWithoutCompleteFigures: [...new Set(rows.filter((r) => r.observedIsLowerBound).map((r) => r.type))].filter((t) => !byType[t]),
    };
    writeFileSync(path.join(HERE, "../../services/response-service/src/data/casualty-validation.json"), JSON.stringify(live, null, 2) + "\n");
    console.log("wrote services/response-service/src/data/casualty-validation.json");
  }
}
