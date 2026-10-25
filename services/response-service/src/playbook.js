/**
 * Phase 15 — the response playbook (docs/PHASE-15-RESPONSE-ENGINE.md §2).
 *
 * Pure functions, no I/O: given a disaster and what the four services said
 * about its surroundings (their reaction payloads), decide which actions to
 * propose. Keeping it pure makes the policy easy to read, test and change.
 *
 * DEMO POLICY, not clinical or emergency-management guidance: the numbers
 * are illustrative, like the blood-demand forecast.
 */

/** What each severity needs at a baseline. */
export const NEEDS_BY_SEVERITY = Object.freeze({
  LOW: { ambulances: 1, bloodUnitsPerType: 0 },
  MEDIUM: { ambulances: 2, bloodUnitsPerType: 2 },
  HIGH: { ambulances: 4, bloodUnitsPerType: 4 },
  CRITICAL: { ambulances: 6, bloodUnitsPerType: 8 },
});

/** How each disaster type changes the baseline (multipliers, rounded up). */
export const TYPE_FACTORS = Object.freeze({
  FLOOD: { ambulances: 1, blood: 1 },
  FIRE: { ambulances: 1, blood: 1.5 }, // burns: more transfusions
  EARTHQUAKE: { ambulances: 1.5, blood: 1 }, // many casualties, spread out
  CYCLONE: { ambulances: 1.25, blood: 1 },
  LANDSLIDE: { ambulances: 1, blood: 1 },
  INDUSTRIAL_ACCIDENT: { ambulances: 1.25, blood: 1.5 },
});

/** Universal-donor red cells first: usable before the patient's group is known. */
export const BLOOD_TYPES = Object.freeze(["O-", "O+"]);

/** Escalation never widens the search past this, and happens once per disaster. */
export const MAX_RADIUS_KM = 50;

export const ACTION_KINDS = Object.freeze({
  AMBULANCE_DISPATCH: "ambulance.dispatch",
  BLOOD_RESERVE: "blood.reserve",
  BEDS_RESERVE: "hospital.reserve_beds", // Phase 20
  WIDEN_RADIUS: "disaster.widen_radius",
  NOTICE: "notice",
});

/** Ambulances and blood units per type this disaster calls for (the severity table: the minimum). */
export function computeNeeds({ type, severity }) {
  const base = NEEDS_BY_SEVERITY[severity] || NEEDS_BY_SEVERITY.MEDIUM;
  const factor = TYPE_FACTORS[type] || { ambulances: 1, blood: 1 };
  return {
    ambulances: Math.ceil(base.ambulances * factor.ambulances),
    bloodUnitsPerType: Math.ceil(base.bloodUnitsPerType * factor.blood),
  };
}

/**
 * Phase 20: the table above is the floor; the impact estimate (impact.js)
 * raises it when the zone's population says more is needed, and adds the
 * beds and ICU beds to reserve. Without an estimate: the table alone.
 */
export function combineNeeds(disaster, impact) {
  const base = computeNeeds(disaster);
  if (!impact) return base;
  return {
    ambulances: Math.max(base.ambulances, impact.ambulances),
    bloodUnitsPerType: Math.max(base.bloodUnitsPerType, impact.bloodUnitsPerType),
    hospitalBeds: impact.hospitalBeds,
    icuBeds: impact.icuBeds,
    estimatedCasualties: impact.casualties,
  };
}

/**
 * Phase 22: what the validation says about this kind of estimate, in words
 * (docs/PHASE-22-VALIDATION.md). Ratios are actual / estimated casualties in
 * past Indian disasters.
 */
export function validationSentence(type, record) {
  const kind = String(type || "event").toLowerCase().replace(/_/g, " ");
  const fmt = (x) => (x >= 10 ? Math.round(x).toLocaleString("en-IN") : String(x));
  if (!record || !record.events) {
    return `No ${kind} with complete casualty figures to validate against; treat the estimate as indicative only.`;
  }
  if (record.events === 1) {
    return `In the one past ${kind} checked, actual casualties were ${fmt(record.actualOverEstimateMin)}× this model's estimate: treat it as a lower bound.`;
  }
  return `In ${record.events} past ${kind}s checked, actual casualties were ${fmt(record.actualOverEstimateMin)}–${fmt(record.actualOverEstimateMax)}× this model's estimate: treat it as a lower bound.`;
}

/** Phase 20: a hospital never gives more than this share of its free beds to one plan. */
export const MAX_RESERVE_SHARE = 0.8;
/** At most this many hospitals per bed-reservation round. */
export const MAX_RESERVE_HOSPITALS = 6;

/** True if the hospital's 24 h forecast says it will be (or is) full soon. */
export function fillsSoon(h) {
  const f = h?.forecast;
  return Boolean(f && (f.risk === "CRITICAL" || (Number.isFinite(f.hoursToFull) && f.hoursToFull <= 6)));
}

/**
 * Hospitals in the order beds are taken from them: not overloaded and not
 * filling up per the forecast first, then those filling up, then overloaded
 * ones; nearest first within each group.
 */
export function rankHospitals(hospitalReaction, { exclude = [] } = {}) {
  const list = (Array.isArray(hospitalReaction?.nearbyHospitals) ? hospitalReaction.nearbyHospitals : []).filter((h) => !exclude.includes(h.id));
  const group = (h) => (h.emergencyStatus === "OVERLOADED" ? 2 : fillsSoon(h) ? 1 : 0);
  return [...list].sort((a, b) => group(a) - group(b) || a.distanceKm - b.distanceKm);
}

/**
 * Spreads `beds` and `icuBeds` over the ranked hospitals, taking at most
 * MAX_RESERVE_SHARE of each one's free beds (the rest stays for everyday
 * patients). Returns { allocations: [{ hospital, beds, icuBeds }], shortBeds, shortIcu }.
 */
export function allocateBeds(hospitalReaction, { beds, icuBeds, exclude = [] }) {
  let needBeds = Math.max(0, beds);
  let needIcu = Math.max(0, icuBeds);
  const allocations = [];
  for (const h of rankHospitals(hospitalReaction, { exclude })) {
    if ((needBeds === 0 && needIcu === 0) || allocations.length >= MAX_RESERVE_HOSPITALS) break;
    const takeBeds = Math.min(needBeds, Math.floor((h.availableBeds || 0) * MAX_RESERVE_SHARE));
    const takeIcu = Math.min(needIcu, Math.floor((h.availableIcuBeds || 0) * MAX_RESERVE_SHARE));
    if (takeBeds + takeIcu === 0) continue;
    allocations.push({ hospital: h, beds: takeBeds, icuBeds: takeIcu });
    needBeds -= takeBeds;
    needIcu -= takeIcu;
  }
  return { allocations, shortBeds: needBeds, shortIcu: needIcu };
}

/** The escalated radius: double, at least +5 km, never past MAX_RADIUS_KM. */
export function widenedRadius(radiusKm) {
  return Math.min(MAX_RADIUS_KM, Math.max(radiusKm * 2, radiusKm + 5));
}

/**
 * Nearest hospital that can take patients (free beds, not OVERLOADED), else
 * the nearest with free beds. Phase 20: one whose forecast says it fills up
 * within 6 hours comes after the others.
 */
export function pickReceivingHospital(hospitalReaction) {
  return rankHospitals(hospitalReaction).find((h) => h.availableBeds > 0) || null;
}

/** True if the reaction reports LOW_STOCK of `bloodType` at this bank. */
export function bankIsLow(bloodReaction, bank, bloodType) {
  return (bloodReaction?.shortageAlerts || []).some(
    (a) => a.type === "LOW_STOCK" && a.bloodType === bloodType && (a.bloodBankId ? a.bloodBankId === bank.id : a.bloodBankName === bank.name)
  );
}

/**
 * Nearest bank for one blood type, skipping banks in `exclude` (where this
 * type already failed) and preferring one without a LOW_STOCK alert for it.
 */
export function pickBloodBank(bloodReaction, { bloodType, exclude = [] } = {}) {
  const list = (Array.isArray(bloodReaction?.nearbyBloodBanks) ? bloodReaction.nearbyBloodBanks : [])
    .filter((b) => !exclude.includes(b.id))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  if (!bloodType) return list[0] || null;
  return list.find((b) => !bankIsLow(bloodReaction, b, bloodType)) || list[0] || null;
}

/**
 * Builds the actions for one plan.
 *
 * @param disaster   { id, type, severity, latitude, longitude, radiusKm, description }
 * @param reactions  { hospital?, ambulance?, blood?, power? } — reaction payloads for the CURRENT radius
 * @param revision   1 = first plan; 2 = follow-up after an escalation (shortfall only, no second escalation)
 * @param delivered  what earlier revisions already achieved: { ambulances, bloodUnits: { "O-": n },
 *                   failedBloodBanks: { "O-": [bankId] }, beds, icuBeds, failedHospitals: [id] }
 * @param impact     Phase 20: estimateImpact(disaster) (impact.js); absent = severity table only, no beds
 * @returns { needs, actions: [{ kind, params, reason }] }
 */
export function buildPlan({ disaster, reactions = {}, revision = 1, delivered = { ambulances: 0, bloodUnits: {} }, impact = null }) {
  const needs = combineNeeds(disaster, impact);
  const actions = [];
  const radius = disaster.radiusKm;

  // --- Ambulances -------------------------------------------------------
  const stillNeeded = Math.max(0, needs.ambulances - (delivered.ambulances || 0));
  const available = Number.isInteger(reactions.ambulance?.availableAmbulanceCount) ? reactions.ambulance.availableAmbulanceCount : null;
  // Send what's close by now; if the circle is short, widen it and send the
  // rest from the wider circle in revision 2. Unknown availability: send the
  // lot and let dispatch find the nearest (it searches 50 km itself).
  const dispatchNow = available === null ? stillNeeded : Math.min(stillNeeded, available);
  if (dispatchNow > 0) {
    actions.push({
      kind: ACTION_KINDS.AMBULANCE_DISPATCH,
      params: { count: dispatchNow },
      reason:
        available === null
          ? `${disaster.severity} ${disaster.type} needs ${needs.ambulances} ambulance(s); availability not reported yet, so dispatch picks the nearest.`
          : `${disaster.severity} ${disaster.type} needs ${needs.ambulances}${revision > 1 ? ` (${delivered.ambulances} already sent)` : ""}; ${available} free within ${radius} km.`,
    });
  }
  const shortfall = stillNeeded - dispatchNow;
  if (shortfall > 0) {
    if (revision === 1 && radius < MAX_RADIUS_KM) {
      const to = widenedRadius(radius);
      actions.push({
        kind: ACTION_KINDS.WIDEN_RADIUS,
        params: { fromRadiusKm: radius, radiusKm: to },
        reason: `Short of ${shortfall} ambulance(s) within ${radius} km: widen the search to ${to} km and plan the rest from there.`,
      });
    } else {
      actions.push({
        kind: ACTION_KINDS.NOTICE,
        params: { topic: "ambulance-shortfall", shortfall },
        reason: `Still short of ${shortfall} ambulance(s) within ${radius} km after escalation: request mutual aid from neighbouring districts.`,
      });
    }
  }

  // --- Beds (Phase 20) ---------------------------------------------------
  let bedHospital = null;
  if (impact) {
    const wantBeds = Math.max(0, (needs.hospitalBeds || 0) - (delivered.beds || 0));
    const wantIcu = Math.max(0, (needs.icuBeds || 0) - (delivered.icuBeds || 0));
    if (wantBeds + wantIcu > 0) {
      if (!reactions.hospital) {
        actions.push({ kind: ACTION_KINDS.NOTICE, params: { topic: "beds-unplaced" }, reason: "Bed reservation skipped: hospital information hasn't arrived yet." });
      } else {
        const { allocations, shortBeds, shortIcu } = allocateBeds(reactions.hospital, { beds: wantBeds, icuBeds: wantIcu, exclude: delivered.failedHospitals || [] });
        for (const { hospital: h, beds, icuBeds } of allocations) {
          actions.push({
            kind: ACTION_KINDS.BEDS_RESERVE,
            params: { hospitalId: h.id, hospitalName: h.name, beds, icuBeds },
            reason:
              `Hold ${beds} bed(s)${icuBeds ? ` and ${icuBeds} ICU bed(s)` : ""} at ${h.name} (${h.distanceKm} km, ${h.availableBeds} free)` +
              (fillsSoon(h) ? "; its forecast says it fills up soon, so it is asked after the others." : "."),
          });
        }
        bedHospital = allocations[0]?.hospital || null;
        if (shortBeds + shortIcu > 0) {
          actions.push({
            kind: ACTION_KINDS.NOTICE,
            params: { topic: "bed-shortfall", shortBeds, shortIcu },
            reason: `${shortBeds} bed(s) and ${shortIcu} ICU bed(s) of the estimated need can't be held within ${radius} km (hospitals keep 20% of their free beds): alert hospitals further out.`,
          });
        }
      }
    }
  }

  // --- Blood ------------------------------------------------------------
  const bloodWanted = BLOOD_TYPES.map((bloodType) => ({
    bloodType,
    units: Math.max(0, needs.bloodUnitsPerType - (delivered.bloodUnits?.[bloodType] || 0)),
  })).filter((b) => b.units > 0);
  if (bloodWanted.length > 0) {
    // Blood follows the patients: to the hospital holding the most beds, else the best receiving one.
    const hospital = bedHospital || pickReceivingHospital(reactions.hospital);
    if (!hospital || !reactions.blood) {
      actions.push({
        kind: ACTION_KINDS.NOTICE,
        params: { topic: "blood-unplaced" },
        reason: !reactions.hospital || !reactions.blood
          ? "Blood reservation skipped: hospital or blood-bank information hasn't arrived yet."
          : `Blood reservation skipped: no hospital with free beds within ${radius} km.`,
      });
    } else {
      for (const { bloodType, units } of bloodWanted) {
        // Per type: a bank that already failed this type isn't asked again,
        // and a bank without a low-stock alert for it is preferred.
        const bank = pickBloodBank(reactions.blood, { bloodType, exclude: delivered.failedBloodBanks?.[bloodType] || [] });
        if (!bank) {
          actions.push({
            kind: ACTION_KINDS.NOTICE,
            params: { topic: "blood-unplaced", bloodType },
            reason: `No other blood bank within ${radius} km can be asked for ${bloodType}: arrange a transfer from further away.`,
          });
          continue;
        }
        const low = bankIsLow(reactions.blood, bank, bloodType);
        actions.push({
          kind: ACTION_KINDS.BLOOD_RESERVE,
          params: { bloodBankId: bank.id, bloodBankName: bank.name, bloodType, units, hospitalId: hospital.id, hospitalName: hospital.name },
          reason: `${units} unit(s) of ${bloodType} from ${bank.name} (${bank.distanceKm} km) for ${hospital.name} (${hospital.distanceKm} km), the nearest hospital with free beds.${low ? ` Every bank in range reports low stock of ${bloodType}; the reservation may fail.` : ""}`,
        });
      }
    }
  }

  // --- Things only a person can act on (first plan only) ----------------
  if (revision === 1) {
    if (impact) {
      actions.unshift({
        kind: ACTION_KINDS.NOTICE,
        params: { topic: "impact-estimate", population: impact.population, exposed: impact.exposed, casualties: impact.casualties },
        reason:
          `Estimate: ~${impact.population.toLocaleString("en-IN")} people live within ${radius} km, ~${impact.exposed.toLocaleString("en-IN")} exposed; ~${impact.casualties} casualties expected, ` +
          `needing ~${impact.hospitalBeds} bed(s), ~${impact.icuBeds} ICU bed(s) and ~${impact.transport} ambulance transport(s). ` +
          validationSentence(disaster.type, impact.assumptions?.validation),
      });
    }
    // Without an estimate, the old rule of thumb: about one ICU bed per ambulance sent.
    // With one, the bed-shortfall notice above already covers ICU beds.
    const icu = reactions.hospital?.totalAvailableIcuBeds;
    if (!impact && Number.isInteger(icu) && icu < needs.ambulances) {
      actions.push({
        kind: ACTION_KINDS.NOTICE,
        params: { topic: "icu-capacity", availableIcuBeds: icu },
        reason: `Only ${icu} free ICU bed(s) within ${radius} km for up to ${needs.ambulances} critical patients: alert hospitals further out.`,
      });
    }
    const atRisk = reactions.power?.totalAtRiskTransformerCount;
    // Phase 20: transformers the risk forecast flags (score ≥ 50) while still NORMAL now.
    const forecastRisk = Array.isArray(reactions.power?.forecastAtRiskTransformers) ? reactions.power.forecastAtRiskTransformers : [];
    const flagged = forecastRisk.filter((t) => t.status === "NORMAL");
    if ((Number.isInteger(atRisk) && atRisk > 0) || flagged.length > 0) {
      const parts = [];
      if (atRisk > 0) parts.push(`${atRisk} transformer(s) already at risk`);
      if (flagged.length > 0) parts.push(`${flagged.length} more flagged by the risk forecast (${flagged.slice(0, 3).map((t) => `${t.code} ${t.score}/100`).join(", ")})`);
      actions.push({
        kind: ACTION_KINDS.NOTICE,
        params: { topic: "power-at-risk", atRiskTransformers: atRisk || 0, forecastFlagged: flagged.length },
        reason: `${parts.join("; ")} within ${radius} km: send a line crew before hospitals lose power.`,
      });
    }
  }

  return { needs, actions };
}
