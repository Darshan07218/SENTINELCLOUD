// Phase 20: the impact estimate and the plans built from it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { estimateImpact, populationWithin, densityAt, RURAL_DENSITY, FIRST_WAVE_MAX_AMBULANCES } from "../src/impact.js";
import { buildPlan, combineNeeds, allocateBeds, rankHospitals, pickReceivingHospital, fillsSoon, ACTION_KINDS, MAX_RESERVE_SHARE } from "../src/playbook.js";

const PUNE = { latitude: 18.52, longitude: 73.855 };

describe("population model", () => {
  test("the PMC circle holds roughly its census population (3.1 M in 2011, ± 20 %)", () => {
    const p = populationWithin(18.52, 73.855, 9);
    assert.ok(p > 2.6e6 && p < 3.8e6, `${p}`);
  });

  test("the old city is denser than the corporation, which is denser than the countryside", () => {
    assert.ok(densityAt(18.514, 73.857) > densityAt(18.56, 73.92));
    assert.equal(densityAt(19.5, 75), RURAL_DENSITY);
  });

  test("a wider circle never holds fewer people", () => {
    assert.ok(populationWithin(18.52, 73.855, 20) > populationWithin(18.52, 73.855, 10));
  });
});

describe("estimateImpact", () => {
  const quake = (severity, radiusKm = 15) => estimateImpact({ type: "EARTHQUAKE", severity, radiusKm, ...PUNE });

  test("casualties rise steeply with severity", () => {
    const [low, med, high, crit] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => quake(s).casualties);
    assert.ok(low < med && med < high && high < crit);
    assert.ok(crit >= 10 * med, `CRITICAL ${crit} vs MEDIUM ${med}`);
  });

  test("a MEDIUM quake under the city: hundreds of casualties, not thousands", () => {
    const i = quake("MEDIUM");
    assert.ok(i.casualties >= 100 && i.casualties < 1000, `${i.casualties}`);
  });

  test("beds, ICU and transport are shares of the casualties; ambulances are capped for the first wave", () => {
    const i = quake("HIGH");
    assert.equal(i.hospitalBeds, Math.ceil(i.casualties * 0.4));
    assert.equal(i.icuBeds, Math.ceil(i.casualties * 0.1));
    assert.equal(i.ambulances, FIRST_WAVE_MAX_AMBULANCES);
  });

  test("the same event in the countryside affects far fewer people", () => {
    const city = estimateImpact({ type: "FLOOD", severity: "HIGH", radiusKm: 10, ...PUNE });
    const rural = estimateImpact({ type: "FLOOD", severity: "HIGH", radiusKm: 10, latitude: 19.5, longitude: 75 });
    assert.ok(rural.population < city.population / 10);
    assert.ok(rural.casualties < city.casualties);
  });

  test("a small local fire stays small", () => {
    const i = estimateImpact({ type: "FIRE", severity: "HIGH", radiusKm: 2, ...PUNE });
    assert.ok(i.casualties < 50, `${i.casualties}`);
  });
});

describe("combineNeeds", () => {
  test("the severity table is the floor; the estimate raises it", () => {
    const d = { type: "LANDSLIDE", severity: "LOW" };
    assert.deepEqual(combineNeeds(d, null), { ambulances: 1, bloodUnitsPerType: 0 });
    const tiny = combineNeeds(d, { ambulances: 0, bloodUnitsPerType: 0, hospitalBeds: 1, icuBeds: 0, casualties: 2 });
    assert.equal(tiny.ambulances, 1, "never below the table");
    const big = combineNeeds({ type: "FLOOD", severity: "HIGH" }, { ambulances: 9, bloodUnitsPerType: 20, hospitalBeds: 90, icuBeds: 23, casualties: 223 });
    assert.deepEqual([big.ambulances, big.bloodUnitsPerType, big.hospitalBeds, big.icuBeds], [9, 20, 90, 23]);
  });
});

const H = (id, distanceKm, availableBeds, availableIcuBeds, extra = {}) => ({ id, name: `Hospital ${id}`, distanceKm, availableBeds, availableIcuBeds, emergencyStatus: "NORMAL", ...extra });

describe("forecast-aware hospital choice", () => {
  const reaction = {
    nearbyHospitals: [
      H("near-filling", 1, 50, 5, { forecast: { risk: "CRITICAL", hoursToFull: 3 } }),
      H("mid", 3, 40, 4, { forecast: { risk: "LOW", hoursToFull: null } }),
      H("far", 8, 100, 10),
      H("overloaded", 0.5, 30, 3, { emergencyStatus: "OVERLOADED" }),
    ],
  };

  test("fillsSoon reads the forecast", () => {
    assert.equal(fillsSoon(reaction.nearbyHospitals[0]), true);
    assert.equal(fillsSoon(reaction.nearbyHospitals[1]), false);
    assert.equal(fillsSoon(H("x", 1, 1, 0, { forecast: { risk: "HIGH", hoursToFull: 5 } })), true);
  });

  test("order: healthy by distance, then filling up, then overloaded", () => {
    assert.deepEqual(rankHospitals(reaction).map((h) => h.id), ["mid", "far", "near-filling", "overloaded"]);
    assert.equal(pickReceivingHospital(reaction).id, "mid");
  });

  test("beds are spread in that order, taking at most 80 % of each hospital's free beds", () => {
    const { allocations, shortBeds, shortIcu } = allocateBeds(reaction, { beds: 100, icuBeds: 8 });
    assert.deepEqual(
      allocations.map((a) => [a.hospital.id, a.beds, a.icuBeds]),
      [
        ["mid", 32, 3],
        ["far", 68, 5],
      ]
    );
    assert.equal(shortBeds + shortIcu, 0);
    assert.ok(allocations.every((a) => a.beds <= Math.floor(a.hospital.availableBeds * MAX_RESERVE_SHARE)));
  });

  test("when the need is larger than the 80 % of every hospital, the rest is reported as a shortfall", () => {
    const { shortBeds } = allocateBeds(reaction, { beds: 1000, icuBeds: 0 });
    assert.equal(shortBeds, 1000 - (32 + 80 + 40 + 24));
  });
});

describe("buildPlan with an impact estimate", () => {
  const disaster = { id: "d1", type: "FLOOD", severity: "HIGH", radiusKm: 10, ...PUNE, description: "river" };
  const impact = estimateImpact(disaster);
  const reactions = {
    hospital: {
      totalAvailableIcuBeds: 20,
      nearbyHospitals: [H("h1", 2, 80, 10, { forecast: { risk: "CRITICAL", hoursToFull: 2 } }), H("h2", 4, 120, 12, { forecast: { risk: "LOW" } })],
    },
    ambulance: { availableAmbulanceCount: 10 },
    blood: { nearbyBloodBanks: [{ id: "b1", name: "Bank 1", distanceKm: 2 }], shortageAlerts: [] },
    power: { totalAtRiskTransformerCount: 0, forecastAtRiskTransformers: [{ code: "TXF-1", score: 62, level: "HIGH", status: "NORMAL" }] },
  };
  const plan = buildPlan({ disaster, reactions, impact });
  const kinds = (k) => plan.actions.filter((a) => a.kind === k);

  test("the first action explains the estimate", () => {
    assert.equal(plan.actions[0].kind, ACTION_KINDS.NOTICE);
    assert.equal(plan.actions[0].params.topic, "impact-estimate");
    assert.equal(plan.actions[0].params.casualties, impact.casualties);
  });

  test("ambulances follow the estimate (capped first wave), not the HIGH table's 4", () => {
    assert.equal(kinds(ACTION_KINDS.AMBULANCE_DISPATCH)[0].params.count, Math.min(10, impact.ambulances));
    assert.ok(plan.needs.ambulances > 4);
  });

  test("beds are held first at the hospital that is NOT filling up", () => {
    const beds = kinds(ACTION_KINDS.BEDS_RESERVE);
    assert.ok(beds.length >= 1);
    assert.equal(beds[0].params.hospitalId, "h2");
    const held = beds.reduce((n, a) => n + a.params.beds, 0);
    assert.ok(held <= impact.hospitalBeds);
  });

  test("blood goes to the hospital holding the beds", () => {
    for (const b of kinds(ACTION_KINDS.BLOOD_RESERVE)) assert.equal(b.params.hospitalId, "h2");
  });

  test("a transformer the forecast flags gets the power notice even if none is failing yet", () => {
    const power = plan.actions.find((a) => a.params?.topic === "power-at-risk");
    assert.ok(power);
    assert.match(power.reason, /TXF-1 62\/100/);
  });

  test("revision 2 asks only for the beds still missing, and not again at a hospital that refused", () => {
    const rev2 = buildPlan({
      disaster: { ...disaster, radiusKm: 20 },
      reactions,
      impact,
      revision: 2,
      delivered: { ambulances: 10, bloodUnits: { "O-": 99, "O+": 99 }, beds: impact.hospitalBeds - 5, icuBeds: impact.icuBeds, failedHospitals: ["h2"] },
    });
    const beds = rev2.actions.filter((a) => a.kind === ACTION_KINDS.BEDS_RESERVE);
    assert.deepEqual(
      beds.map((a) => [a.params.hospitalId, a.params.beds]),
      [["h1", 5]]
    );
    assert.equal(rev2.actions.some((a) => a.params?.topic === "impact-estimate"), false, "the estimate notice is for the first plan");
  });
});
