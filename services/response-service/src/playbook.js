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
  WIDEN_RADIUS: "disaster.widen_radius",
  NOTICE: "notice",
});

/** Ambulances and blood units per type this disaster calls for. */
export function computeNeeds({ type, severity }) {
  const base = NEEDS_BY_SEVERITY[severity] || NEEDS_BY_SEVERITY.MEDIUM;
  const factor = TYPE_FACTORS[type] || { ambulances: 1, blood: 1 };
  return {
    ambulances: Math.ceil(base.ambulances * factor.ambulances),
    bloodUnitsPerType: Math.ceil(base.bloodUnitsPerType * factor.blood),
  };
}

/** The escalated radius: double, at least +5 km, never past MAX_RADIUS_KM. */
export function widenedRadius(radiusKm) {
  return Math.min(MAX_RADIUS_KM, Math.max(radiusKm * 2, radiusKm + 5));
}

/** Nearest hospital that can take patients (free beds, not OVERLOADED), else the nearest with free beds. */
export function pickReceivingHospital(hospitalReaction) {
  const list = Array.isArray(hospitalReaction?.nearbyHospitals) ? hospitalReaction.nearbyHospitals : [];
  const byDistance = [...list].sort((a, b) => a.distanceKm - b.distanceKm);
  return (
    byDistance.find((h) => h.availableBeds > 0 && h.emergencyStatus !== "OVERLOADED") ||
    byDistance.find((h) => h.availableBeds > 0) ||
    null
  );
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
 *                   failedBloodBanks: { "O-": [bankId] } } — banks not to ask again for that type
 * @returns { needs, actions: [{ kind, params, reason }] }
 */
export function buildPlan({ disaster, reactions = {}, revision = 1, delivered = { ambulances: 0, bloodUnits: {} } }) {
  const needs = computeNeeds(disaster);
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

  // --- Blood ------------------------------------------------------------
  const bloodWanted = BLOOD_TYPES.map((bloodType) => ({
    bloodType,
    units: Math.max(0, needs.bloodUnitsPerType - (delivered.bloodUnits?.[bloodType] || 0)),
  })).filter((b) => b.units > 0);
  if (bloodWanted.length > 0) {
    const hospital = pickReceivingHospital(reactions.hospital);
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
    const icu = reactions.hospital?.totalAvailableIcuBeds;
    if (Number.isInteger(icu) && icu < needs.ambulances) {
      actions.push({
        kind: ACTION_KINDS.NOTICE,
        params: { topic: "icu-capacity", availableIcuBeds: icu },
        reason: `Only ${icu} free ICU bed(s) within ${radius} km for up to ${needs.ambulances} critical patients: alert hospitals further out.`,
      });
    }
    const atRisk = reactions.power?.totalAtRiskTransformerCount;
    if (Number.isInteger(atRisk) && atRisk > 0) {
      actions.push({
        kind: ACTION_KINDS.NOTICE,
        params: { topic: "power-at-risk", atRiskTransformers: atRisk },
        reason: `${atRisk} transformer(s) at risk within ${radius} km: send a line crew before hospitals lose power.`,
      });
    }
  }

  return { needs, actions };
}
