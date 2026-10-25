// Phase 22: the casualty-model validation (tools/validation) stays true.
// Re-runs it from events.json and checks the committed results, and the
// record response-service quotes in every plan, still match. Changing the
// model (services/response-service/src/impact.js) without re-running
//   node tools/validation/validate-casualty-model.mjs --write
// fails here, so the record an operator reads can't go stale.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../tools/validation/validate-casualty-model.mjs";
import { eventInputs } from "../../tools/validation/model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const json = (p) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

describe("casualty-model validation", () => {
  const fresh = validate();

  test("the committed results match a fresh run", () => {
    const committed = json("tools/validation/results.json");
    assert.deepEqual(committed.rows, fresh.rows);
    assert.deepEqual(committed.summary, fresh.summary);
  });

  test("the record response-service quotes matches the results", () => {
    const live = json("services/response-service/src/data/casualty-validation.json");
    const complete = fresh.rows.filter((r) => !r.observedIsLowerBound);
    assert.equal(live.overall.events, complete.length);
    for (const [type, rec] of Object.entries(live.byType)) {
      const rs = complete.filter((r) => r.type === type);
      assert.equal(rec.events, rs.length, type);
      const under = rs.map((r) => r.observed / Math.max(r.predicted, 1));
      assert.equal(rec.actualOverEstimateMax, Math.round(Math.max(...under) * 10) / 10, type);
    }
  });

  test("inputs follow the fixed rules, never the outcome", () => {
    const doc = json("tools/validation/events.json");
    for (const ev of doc.events) {
      const { severity, radiusKm } = eventInputs(ev);
      assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity), ev.id);
      assert.ok(radiusKm > 0, ev.id);
      assert.ok(Number.isInteger(ev.population2020) && ev.population2020 >= 0, `${ev.id}: run event-populations.mjs`);
      assert.match(ev.source, /^https:\/\//, ev.id);
      if (ev.type === "EARTHQUAKE") assert.equal(ev.severity, undefined, `${ev.id}: earthquake severity must come from the magnitude rule`);
    }
  });

  test("every event with complete figures has a usable prediction", () => {
    for (const r of fresh.rows.filter((x) => !x.observedIsLowerBound)) assert.ok(r.observed > 0 && r.predicted >= 0, r.id);
  });
});

describe("bed-occupancy forecast settings", () => {
  test("the live settings are the ones tuned on 2021–2022 and tested on 2023", async () => {
    const { FORECAST_SETTINGS } = await import("../../services/hospital-service/src/services/forecast.js");
    const tuning = json("tools/validation/tuning-occupancy.json");
    for (const k of ["alpha", "beta", "phi", "bandZ"]) assert.equal(FORECAST_SETTINGS[k], tuning.tuned[k], k);
    assert.ok(tuning.test2023.skillTuned >= 0, "tuned settings must not be worse than persistence on the unseen year");
  });
});
