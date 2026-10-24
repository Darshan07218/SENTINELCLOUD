// Phase 15: the playbook is pure policy, so every rule in
// docs/PHASE-15-RESPONSE-ENGINE.md §2 is checked here directly.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeNeeds, widenedRadius, buildPlan, pickReceivingHospital, pickBloodBank, ACTION_KINDS, MAX_RADIUS_KM } from "../src/playbook.js";

const flood = (severity = "HIGH", radiusKm = 15, type = "FLOOD") => ({
  id: "11111111-1111-1111-1111-111111111111", type, severity, latitude: 18.52, longitude: 73.85, radiusKm, description: "test",
});
const hospital = (id, distanceKm, availableBeds = 20, emergencyStatus = "NORMAL") => ({ id, name: `H-${id}`, distanceKm, availableBeds, availableIcuBeds: 3, availableVentilators: 1, emergencyStatus });
const reactions = ({ ambulances = 8, icu = 20, atRisk = 0, hospitals = [hospital("h1", 2)], banks = [{ id: "b1", name: "Bank One", distanceKm: 3 }], alerts = [] } = {}) => ({
  hospital: { searchRadiusKm: 15, nearbyHospitals: hospitals, totalAvailableIcuBeds: icu },
  ambulance: { searchRadiusKm: 15, availableAmbulanceCount: ambulances },
  blood: { searchRadiusKm: 15, nearbyBloodBanks: banks, shortageAlerts: alerts },
  power: { searchRadiusKm: 15, totalAtRiskTransformerCount: atRisk },
});
const kinds = (plan) => plan.actions.map((a) => a.kind);
const of = (plan, kind) => plan.actions.filter((a) => a.kind === kind);

describe("computeNeeds", () => {
  test("baseline per severity", () => {
    assert.deepEqual(computeNeeds({ type: "FLOOD", severity: "LOW" }), { ambulances: 1, bloodUnitsPerType: 0 });
    assert.deepEqual(computeNeeds({ type: "FLOOD", severity: "MEDIUM" }), { ambulances: 2, bloodUnitsPerType: 2 });
    assert.deepEqual(computeNeeds({ type: "FLOOD", severity: "HIGH" }), { ambulances: 4, bloodUnitsPerType: 4 });
    assert.deepEqual(computeNeeds({ type: "FLOOD", severity: "CRITICAL" }), { ambulances: 6, bloodUnitsPerType: 8 });
  });
  test("type factors round up", () => {
    assert.equal(computeNeeds({ type: "EARTHQUAKE", severity: "CRITICAL" }).ambulances, 9); // 6 × 1.5
    assert.equal(computeNeeds({ type: "CYCLONE", severity: "MEDIUM" }).ambulances, 3); // 2 × 1.25 = 2.5 → 3
    assert.equal(computeNeeds({ type: "FIRE", severity: "HIGH" }).bloodUnitsPerType, 6); // 4 × 1.5
    assert.deepEqual(computeNeeds({ type: "INDUSTRIAL_ACCIDENT", severity: "HIGH" }), { ambulances: 5, bloodUnitsPerType: 6 });
  });
});

describe("widenedRadius", () => {
  test("doubles, at least +5 km, capped at the maximum", () => {
    assert.equal(widenedRadius(15), 30);
    assert.equal(widenedRadius(3), 8);
    assert.equal(widenedRadius(40), MAX_RADIUS_KM);
  });
});

describe("buildPlan, revision 1", () => {
  test("HIGH flood with enough nearby: dispatch 4, reserve 4 O- and 4 O+, nothing else", () => {
    const plan = buildPlan({ disaster: flood(), reactions: reactions() });
    assert.deepEqual(kinds(plan), [ACTION_KINDS.AMBULANCE_DISPATCH, ACTION_KINDS.BLOOD_RESERVE, ACTION_KINDS.BLOOD_RESERVE]);
    assert.equal(of(plan, ACTION_KINDS.AMBULANCE_DISPATCH)[0].params.count, 4);
    assert.deepEqual(of(plan, ACTION_KINDS.BLOOD_RESERVE).map((a) => [a.params.bloodType, a.params.units, a.params.bloodBankId, a.params.hospitalId]), [
      ["O-", 4, "b1", "h1"],
      ["O+", 4, "b1", "h1"],
    ]);
  });

  test("too few ambulances in range: send what's there and escalate the radius once", () => {
    const plan = buildPlan({ disaster: flood("HIGH", 15), reactions: reactions({ ambulances: 1 }) });
    assert.equal(of(plan, ACTION_KINDS.AMBULANCE_DISPATCH)[0].params.count, 1);
    const [widen] = of(plan, ACTION_KINDS.WIDEN_RADIUS);
    assert.deepEqual(widen.params, { fromRadiusKm: 15, radiusKm: 30 });
    assert.match(widen.reason, /Short of 3 ambulance/);
  });

  test("no ambulance in range at all: no dispatch, only the escalation", () => {
    const plan = buildPlan({ disaster: flood(), reactions: reactions({ ambulances: 0 }) });
    assert.equal(of(plan, ACTION_KINDS.AMBULANCE_DISPATCH).length, 0);
    assert.equal(of(plan, ACTION_KINDS.WIDEN_RADIUS).length, 1);
  });

  test("already at the maximum radius: a mutual-aid notice instead of escalating", () => {
    const plan = buildPlan({ disaster: flood("HIGH", MAX_RADIUS_KM), reactions: reactions({ ambulances: 1 }) });
    assert.equal(of(plan, ACTION_KINDS.WIDEN_RADIUS).length, 0);
    assert.ok(of(plan, ACTION_KINDS.NOTICE).some((n) => n.params.topic === "ambulance-shortfall"));
  });

  test("unknown ambulance availability: dispatch the full need and let dispatch find the nearest", () => {
    const r = reactions();
    delete r.ambulance;
    const plan = buildPlan({ disaster: flood(), reactions: r });
    assert.equal(of(plan, ACTION_KINDS.AMBULANCE_DISPATCH)[0].params.count, 4);
    assert.equal(of(plan, ACTION_KINDS.WIDEN_RADIUS).length, 0);
  });

  test("LOW severity needs no blood", () => {
    const plan = buildPlan({ disaster: flood("LOW"), reactions: reactions() });
    assert.equal(of(plan, ACTION_KINDS.BLOOD_RESERVE).length, 0);
  });

  test("blood goes to the nearest hospital with free beds that isn't overloaded", () => {
    const hospitals = [hospital("full", 1, 0), hospital("over", 2, 10, "OVERLOADED"), hospital("ok", 5, 10)];
    const plan = buildPlan({ disaster: flood(), reactions: reactions({ hospitals }) });
    assert.ok(of(plan, ACTION_KINDS.BLOOD_RESERVE).every((a) => a.params.hospitalId === "ok"));
  });

  test("no blood bank nearby: a notice instead of a reservation", () => {
    const plan = buildPlan({ disaster: flood(), reactions: reactions({ banks: [] }) });
    assert.equal(of(plan, ACTION_KINDS.BLOOD_RESERVE).length, 0);
    assert.ok(of(plan, ACTION_KINDS.NOTICE).some((n) => n.params.topic === "blood-unplaced"));
  });

  test("a low-stock alert at the chosen bank is mentioned, the reservation is still tried", () => {
    const plan = buildPlan({ disaster: flood(), reactions: reactions({ alerts: [{ bloodBankName: "Bank One", bloodType: "O-", type: "LOW_STOCK" }] }) });
    const [oNeg, oPos] = of(plan, ACTION_KINDS.BLOOD_RESERVE);
    assert.match(oNeg.reason, /low stock of O-/);
    assert.doesNotMatch(oPos.reason, /low stock/);
  });

  test("notices for scarce ICU beds and transformers at risk", () => {
    const plan = buildPlan({ disaster: flood(), reactions: reactions({ icu: 2, atRisk: 3 }) });
    const topics = of(plan, ACTION_KINDS.NOTICE).map((n) => n.params.topic);
    assert.ok(topics.includes("icu-capacity"));
    assert.ok(topics.includes("power-at-risk"));
  });
});

describe("buildPlan, revision 2 (after an escalation)", () => {
  test("covers only the shortfall and never escalates again", () => {
    const plan = buildPlan({
      disaster: flood("HIGH", 30),
      reactions: reactions({ ambulances: 1 }),
      revision: 2,
      delivered: { ambulances: 1, bloodUnits: { "O-": 4, "O+": 4 } },
    });
    assert.equal(of(plan, ACTION_KINDS.AMBULANCE_DISPATCH)[0].params.count, 1);
    assert.equal(of(plan, ACTION_KINDS.WIDEN_RADIUS).length, 0);
    assert.equal(of(plan, ACTION_KINDS.BLOOD_RESERVE).length, 0, "blood was already delivered");
    assert.ok(of(plan, ACTION_KINDS.NOTICE).some((n) => n.params.topic === "ambulance-shortfall"), "the rest needs mutual aid");
    assert.ok(!of(plan, ACTION_KINDS.NOTICE).some((n) => n.params.topic === "icu-capacity"), "first-plan notices aren't repeated");
  });

  test("blood that failed at a bank is asked from the next bank, not the same one again", () => {
    const banks = [{ id: "b1", name: "Bank One", distanceKm: 3 }, { id: "b2", name: "Bank Two", distanceKm: 9 }];
    const plan = buildPlan({
      disaster: flood("HIGH", 30),
      reactions: reactions({ banks }),
      revision: 2,
      delivered: { ambulances: 4, bloodUnits: { "O+": 4 }, failedBloodBanks: { "O-": ["b1"] } },
    });
    const [oNeg] = of(plan, ACTION_KINDS.BLOOD_RESERVE);
    assert.equal(oNeg.params.bloodType, "O-");
    assert.equal(oNeg.params.bloodBankId, "b2");
  });

  test("no bank left for a type: a notice instead of asking the failed bank again", () => {
    const plan = buildPlan({
      disaster: flood("HIGH", 30),
      reactions: reactions(),
      revision: 2,
      delivered: { ambulances: 4, bloodUnits: { "O+": 4 }, failedBloodBanks: { "O-": ["b1"] } },
    });
    assert.equal(of(plan, ACTION_KINDS.BLOOD_RESERVE).length, 0);
    assert.ok(of(plan, ACTION_KINDS.NOTICE).some((n) => n.params.topic === "blood-unplaced" && n.params.bloodType === "O-"));
  });

  test("nothing left to do: no actions", () => {
    const plan = buildPlan({ disaster: flood("HIGH", 30), reactions: reactions(), revision: 2, delivered: { ambulances: 4, bloodUnits: { "O-": 4, "O+": 4 } } });
    assert.equal(plan.actions.length, 0);
  });
});

describe("target selection", () => {
  test("pickReceivingHospital falls back to an overloaded hospital that still has beds", () => {
    assert.equal(pickReceivingHospital({ nearbyHospitals: [hospital("over", 2, 5, "OVERLOADED")] }).id, "over");
    assert.equal(pickReceivingHospital({ nearbyHospitals: [hospital("full", 2, 0)] }), null);
    assert.equal(pickReceivingHospital(undefined), null);
  });
  test("pickBloodBank takes the nearest", () => {
    assert.equal(pickBloodBank({ nearbyBloodBanks: [{ id: "far", distanceKm: 9 }, { id: "near", distanceKm: 1 }] }).id, "near");
    assert.equal(pickBloodBank({}), null);
  });
  test("pickBloodBank prefers a bank that isn't low on that type, and skips excluded ones", () => {
    const reaction = {
      nearbyBloodBanks: [{ id: "near", name: "Near", distanceKm: 1 }, { id: "far", name: "Far", distanceKm: 9 }],
      shortageAlerts: [{ type: "LOW_STOCK", bloodType: "O-", bloodBankId: "near", bloodBankName: "Near" }, { type: "EXPIRING_SOON", bloodType: "O+", bloodBankId: "near" }],
    };
    assert.equal(pickBloodBank(reaction, { bloodType: "O-" }).id, "far", "near is low on O-");
    assert.equal(pickBloodBank(reaction, { bloodType: "O+" }).id, "near", "expiring stock isn't a shortage");
    assert.equal(pickBloodBank(reaction, { bloodType: "O+", exclude: ["near"] }).id, "far");
    assert.equal(pickBloodBank(reaction, { bloodType: "O-", exclude: ["far"] }).id, "near", "low but the only one left");
  });
});
