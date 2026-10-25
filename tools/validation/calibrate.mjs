#!/usr/bin/env node
/**
 * Phase 22: can one correction factor per disaster type fix the casualty
 * model? Tested honestly with LEAVE-ONE-OUT: each event is predicted with a
 * factor fitted on the OTHER events of its type only, so the score says how
 * the corrected model would do on a disaster it has not seen.
 *
 * Factor = geometric mean of observed / predicted over the fitting events
 * (the least-squares fit on a log scale). Only events with complete figures
 * (deaths AND injuries reported) are used; types with fewer than two such
 * events can't be cross-validated and are reported as such.
 *
 *   node tools/validation/calibrate.mjs [--write]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate-casualty-model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { rows } = validate();
const complete = rows.filter((r) => !r.observedIsLowerBound && r.predicted > 0);

const logRatio = (r) => Math.log10(r.observed / r.predicted); // how far up the prediction must go
const geoFactor = (rs) => 10 ** (rs.reduce((s, r) => s + logRatio(r), 0) / rs.length);

const byType = {};
for (const r of complete) (byType[r.type] ||= []).push(r);

const report = [];
for (const [type, rs] of Object.entries(byType)) {
  const inSampleFactor = geoFactor(rs);
  const entry = { type, events: rs.length, inSampleFactor: Math.round(inSampleFactor * 10) / 10 };
  if (rs.length >= 2) {
    entry.leaveOneOut = rs.map((held) => {
      const factor = geoFactor(rs.filter((r) => r !== held));
      const corrected = held.predicted * factor;
      return {
        id: held.id,
        factorFromOthers: Math.round(factor * 10) / 10,
        uncorrectedAbsLog10: Math.round(Math.abs(Math.log10(held.predicted / held.observed)) * 100) / 100,
        correctedAbsLog10: Math.round(Math.abs(Math.log10(corrected / held.observed)) * 100) / 100,
      };
    });
    const mean = (k) => entry.leaveOneOut.reduce((s, x) => s + x[k], 0) / entry.leaveOneOut.length;
    entry.meanAbsLog10Uncorrected = Math.round(mean("uncorrectedAbsLog10") * 100) / 100;
    entry.meanAbsLog10LeaveOneOut = Math.round(mean("correctedAbsLog10") * 100) / 100;
    // "Helps" only if the error on unseen events drops by at least 0.1 on the
    // log scale (about 26 %); smaller differences are noise with this few events.
    entry.verdict = entry.meanAbsLog10LeaveOneOut <= entry.meanAbsLog10Uncorrected - 0.1 ? "correction helps on unseen events" : "no meaningful gain on unseen events";
  } else {
    entry.verdict = "one event: a factor would only fit that event, not validate";
  }
  report.push(entry);
}

for (const e of report) {
  console.log(`\n${e.type}: ${e.events} event(s), in-sample factor ×${e.inSampleFactor}`);
  for (const x of e.leaveOneOut || []) {
    console.log(`  ${x.id.padEnd(20)} factor from the others ×${String(x.factorFromOthers).padEnd(8)} error: uncorrected ${(10 ** x.uncorrectedAbsLog10).toFixed(1)}× → corrected ${(10 ** x.correctedAbsLog10).toFixed(1)}×`);
  }
  if (e.leaveOneOut) console.log(`  mean |log10 error|: uncorrected ${e.meanAbsLog10Uncorrected} → leave-one-out ${e.meanAbsLog10LeaveOneOut}  (${e.verdict})`);
  else console.log(`  ${e.verdict}`);
}

if (process.argv.includes("--write")) {
  writeFileSync(path.join(HERE, "calibration.json"), JSON.stringify({ generatedBy: "tools/validation/calibrate.mjs", method: "per-type geometric-mean factor, leave-one-out", report }, null, 2) + "\n");
  console.log("\nwrote tools/validation/calibration.json");
}
