export const AMBULANCE_STATUSES = [
  "AVAILABLE",
  "DISPATCHED",
  "EN_ROUTE",
  "AT_SCENE",
  "TRANSPORTING",
  "AT_HOSPITAL",
  "OUT_OF_SERVICE",
];

/**
 * Legal next-states for each current status: the "happy path" of a
 * real EMS call (AVAILABLE -> DISPATCHED -> EN_ROUTE -> AT_SCENE ->
 * TRANSPORTING -> AT_HOSPITAL -> AVAILABLE), plus realistic exceptions
 * — a crew can be pulled OUT_OF_SERVICE from almost any active state
 * (mechanical issue, crew emergency, etc.), and a couple of "stand
 * down" paths back to AVAILABLE (e.g. a scene call where the patient
 * refuses transport doesn't need a hospital leg).
 *
 * Enforced in the general PATCH /:id/status endpoint. The dedicated
 * dispatch/complete-emergency workflows drive specific transitions
 * (AVAILABLE -> DISPATCHED, * -> AVAILABLE) through this same table
 * rather than bypassing it, so there is exactly one source of truth
 * for "is this transition legal."
 */
export const ALLOWED_TRANSITIONS = {
  AVAILABLE: ["DISPATCHED", "OUT_OF_SERVICE"],
  DISPATCHED: ["EN_ROUTE", "AVAILABLE", "OUT_OF_SERVICE"],
  EN_ROUTE: ["AT_SCENE", "OUT_OF_SERVICE"],
  AT_SCENE: ["TRANSPORTING", "AVAILABLE", "OUT_OF_SERVICE"],
  TRANSPORTING: ["AT_HOSPITAL", "OUT_OF_SERVICE"],
  AT_HOSPITAL: ["AVAILABLE", "OUT_OF_SERVICE"],
  OUT_OF_SERVICE: ["AVAILABLE"],
};

export function isValidStatusTransition(fromStatus, toStatus) {
  if (fromStatus === toStatus) return false; // no-op transitions aren't meaningful; caller should just not call this
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  return Boolean(allowed && allowed.includes(toStatus));
}

export function getAllowedNextStatuses(fromStatus) {
  return ALLOWED_TRANSITIONS[fromStatus] || [];
}
