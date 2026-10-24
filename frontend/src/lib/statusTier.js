/**
 * Canonical 4-tier status palette used everywhere in the Command
 * Center (Phase 8): GREEN=NORMAL, YELLOW=WARNING, ORANGE=HIGH,
 * RED=CRITICAL. Every domain service in this project has its own
 * status vocabulary (hospital emergencyStatus is NORMAL/ELEVATED/OVERLOADED,
 * power InfraStatus is NORMAL/WARNING/CRITICAL/FAILED, disaster/alert
 * severity is LOW/MEDIUM/HIGH/CRITICAL, ambulance status is a fleet
 * state machine like AVAILABLE/DISPATCHED/OUT_OF_SERVICE...) — this
 * module is the ONE place that normalizes all of them onto the same
 * four tiers, so color coding is consistent across every section of
 * the dashboard rather than each section inventing its own mapping.
 */

export const TIERS = ["NORMAL", "WARNING", "HIGH", "CRITICAL"];

export const TIER_COLORS = {
  NORMAL: "#22c55e", // green
  WARNING: "#eab308", // yellow
  HIGH: "#f97316", // orange
  CRITICAL: "#ef4444", // red
  UNKNOWN: "#64748b", // neutral gray for anything not recognized below
};

export const TIER_LABELS = {
  NORMAL: "Normal",
  WARNING: "Warning",
  HIGH: "High",
  CRITICAL: "Critical",
  UNKNOWN: "Unknown",
};

/** Explicit lookup table — every raw status string this project's services actually produce, mapped to one of the four tiers. */
const RAW_TO_TIER = {
  // Generic / severity vocabulary (disasters, hospital & blood-bank & power alerts)
  NORMAL: "NORMAL",
  LOW: "NORMAL",
  WARNING: "WARNING",
  MEDIUM: "WARNING",
  MODERATE: "WARNING", // Phase 18 forecast risk: LOW/MODERATE/HIGH/CRITICAL
  HIGH: "HIGH",
  ELEVATED: "HIGH",
  CRITICAL: "CRITICAL",
  FAILED: "CRITICAL",
  OVERLOADED: "CRITICAL",

  // Ambulance fleet status — AVAILABLE is the "good" state; any
  // actively-in-use state is a normal operational state (not a
  // problem, so WARNING rather than HIGH/CRITICAL); OUT_OF_SERVICE is
  // the one that means "this asset can't help right now."
  AVAILABLE: "NORMAL",
  DISPATCHED: "WARNING",
  EN_ROUTE: "WARNING",
  AT_SCENE: "WARNING",
  TRANSPORTING: "WARNING",
  AT_HOSPITAL: "WARNING",
  OUT_OF_SERVICE: "CRITICAL",

  // Disaster lifecycle status
  ACTIVE: "CRITICAL",
  CONTAINED: "WARNING",
  RESOLVED: "NORMAL",

  // Service health
  OK: "NORMAL",
  UP: "NORMAL",
  READY: "NORMAL",
  DEGRADED: "WARNING",
  DOWN: "CRITICAL",
  NOT_READY: "CRITICAL",
};

/** Normalizes any raw status string this project produces into one of TIERS (or "UNKNOWN" if truly unrecognized). */
export function toTier(rawStatus) {
  if (!rawStatus) return "UNKNOWN";
  const tier = RAW_TO_TIER[String(rawStatus).toUpperCase()];
  return tier || "UNKNOWN";
}

export function tierColor(rawStatus) {
  return TIER_COLORS[toTier(rawStatus)];
}

export function tierLabel(rawStatus) {
  return TIER_LABELS[toTier(rawStatus)];
}

/** Numeric rank for sorting worst-first (CRITICAL highest). UNKNOWN sorts alongside NORMAL. */
export function tierRank(rawStatus) {
  const tier = toTier(rawStatus);
  return { NORMAL: 0, UNKNOWN: 0, WARNING: 1, HIGH: 2, CRITICAL: 3 }[tier];
}

/** Rolls up a list of raw statuses to the single worst tier among them — used for "overall system status" style banners. */
export function worstTier(rawStatuses) {
  let worst = "NORMAL";
  for (const s of rawStatuses) {
    if (tierRank(s) > tierRank(worst)) worst = toTier(s);
  }
  return worst;
}
