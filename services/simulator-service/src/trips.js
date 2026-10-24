/**
 * Phase 16 — ambulance trips for the background mode
 * (docs/PHASE-16-SIMULATOR.md §3). Pure functions: given what an ambulance
 * looks like now, return the ONE next step to take through the API. The
 * ambient loop then performs it. Driven by observed state, not by memory, so
 * a restart of the simulator simply carries on.
 *
 *   DISPATCHED  → EN_ROUTE
 *   EN_ROUTE    → move towards the scene … → AT_SCENE
 *   AT_SCENE    → (after a short stay) choose a hospital → TRANSPORTING
 *   TRANSPORTING→ move towards the hospital … → AT_HOSPITAL
 *   AT_HOSPITAL → complete the call (the ambulance becomes AVAILABLE)
 */

/** Real ambulance speed used by dispatch ETAs (services/ambulance-service routing.js). */
export const ROAD_SPEED_KMH = 55;
/** Demo speed-up: a 10 s tick moves an ambulance 80 s' worth of driving. */
export const DEMO_SPEEDUP = 8;
/** Close enough to count as arrived (km). */
export const ARRIVAL_KM = 0.15;
/** Ticks an ambulance stays at the scene / at the hospital before moving on. */
export const SCENE_TICKS = 2;

const EARTH_RADIUS_KM = 6371;
const rad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Kilometres covered in one tick of `tickSeconds` at demo speed. */
export function kmPerTick(tickSeconds, speedup = DEMO_SPEEDUP) {
  return (ROAD_SPEED_KMH * speedup * tickSeconds) / 3600;
}

/**
 * Moves `stepKm` from `from` towards `to` along the straight line (good
 * enough for a map at city scale). Returns the new point and whether it
 * arrived; never overshoots.
 */
export function moveToward(from, to, stepKm) {
  const remaining = haversineKm(from.latitude, from.longitude, to.latitude, to.longitude);
  if (remaining <= Math.max(stepKm, ARRIVAL_KM)) return { latitude: to.latitude, longitude: to.longitude, arrived: true, remainingKm: 0 };
  const f = stepKm / remaining;
  return {
    latitude: Number((from.latitude + (to.latitude - from.latitude) * f).toFixed(6)),
    longitude: Number((from.longitude + (to.longitude - from.longitude) * f).toFixed(6)),
    arrived: false,
    remainingKm: Number((remaining - stepKm).toFixed(2)),
  };
}

/** Nearest hospital with free beds that isn't OVERLOADED (else any with beds); null if none. */
export function chooseHospital(hospitals, point) {
  const withDistance = (hospitals || [])
    .filter((h) => h.availableBeds > 0)
    .map((h) => ({ ...h, d: haversineKm(point.latitude, point.longitude, h.latitude, h.longitude) }))
    .sort((a, b) => a.d - b.d);
  return withDistance.find((h) => h.emergencyStatus !== "OVERLOADED") || withDistance[0] || null;
}

/**
 * The next step for one ambulance.
 * @param ambulance  { id, status, latitude, longitude, assignedEmergencyId, assignedHospitalId }
 * @param emergency  its call ({ id, latitude, longitude, status }) or null
 * @param hospital   its assigned hospital ({ latitude, longitude }) or null
 * @param dwell      ticks already spent in the current status (scene / hospital stays)
 * @returns one of { type: "status", status } | { type: "move", latitude, longitude, arrived }
 *          | { type: "chooseHospital" } | { type: "complete", emergencyId } | { type: "wait" } | null (nothing to do)
 */
export function nextTripStep({ ambulance, emergency, hospital, dwell = 0, tickSeconds = 10 }) {
  if (!ambulance?.assignedEmergencyId) return null; // not on a call
  if (!emergency || !["ASSIGNED", "ACTIVE"].includes(emergency.status)) return null; // call closed elsewhere
  const step = kmPerTick(tickSeconds);
  switch (ambulance.status) {
    case "DISPATCHED":
      return { type: "status", status: "EN_ROUTE" };
    case "EN_ROUTE": {
      const m = moveToward(ambulance, emergency, step);
      if (haversineKm(ambulance.latitude, ambulance.longitude, emergency.latitude, emergency.longitude) <= ARRIVAL_KM) {
        return { type: "status", status: "AT_SCENE" };
      }
      return { type: "move", ...m };
    }
    case "AT_SCENE":
      if (dwell < SCENE_TICKS) return { type: "wait" };
      if (!ambulance.assignedHospitalId) return { type: "chooseHospital" };
      return { type: "status", status: "TRANSPORTING" };
    case "TRANSPORTING": {
      if (!hospital) return { type: "chooseHospital" };
      if (haversineKm(ambulance.latitude, ambulance.longitude, hospital.latitude, hospital.longitude) <= ARRIVAL_KM) {
        return { type: "status", status: "AT_HOSPITAL" };
      }
      return { type: "move", ...moveToward(ambulance, hospital, step) };
    }
    case "AT_HOSPITAL":
      if (dwell < SCENE_TICKS) return { type: "wait" };
      return { type: "complete", emergencyId: emergency.id };
    default:
      return null; // AVAILABLE / OUT_OF_SERVICE: nothing for a trip to do
  }
}
