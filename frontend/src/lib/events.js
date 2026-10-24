/**
 * Live-feed helpers shared by the Command Center and the Emergency
 * dashboard (engineering review: these tables were duplicated per page and
 * had drifted from what the backend actually publishes).
 *
 * EVENT_LABELS lists EVERY routing key published on the
 * `sentinelcloud.events` exchange — see docs/EVENT-SCHEMA.md.
 */
export const EVENT_LABELS = Object.freeze({
  "disaster.detected": "Disaster Detected",
  "disaster.updated": "Disaster Updated",
  "disaster.resolved": "Disaster Resolved",
  "hospital.capacity.updated": "Hospital Capacity Report",
  "hospital.capacity.alert": "Hospital Capacity Alert",
  "ambulance.status.updated": "Ambulance Availability Report",
  "ambulance.dispatched": "Ambulance Dispatched",
  "emergency.unassigned": "Emergency Unassigned",
  "emergency.resolved": "Emergency Resolved",
  "blood.shortage.detected": "Blood Shortage Report",
  "power.infrastructure.at_risk": "Power Infrastructure Report",
  // Phase 15: the response engine.
  "response.plan.proposed": "Response Plan Proposed",
  "response.plan.approved": "Response Plan Approved",
  "response.plan.rejected": "Response Plan Rejected",
  "response.plan.completed": "Response Plan Finished",
  "response.plan.expired": "Response Plan Expired",
  "response.plan.rolled_back": "Response Plan Undone",
  "command.ambulance.dispatch": "Command: Dispatch Ambulances",
  "command.ambulance.stand-down": "Command: Stand Down Ambulances",
  "command.blood.reserve": "Command: Reserve Blood",
  "command.blood.release": "Command: Release Blood",
  "command.disaster.widen-radius": "Command: Widen Search",
  "command.succeeded": "Command Succeeded",
  "command.failed": "Command Failed",
});

export const EVENT_COLORS = Object.freeze({
  "disaster.detected": "#ef4444",
  "disaster.updated": "#f59e0b",
  "disaster.resolved": "#22c55e",
  "hospital.capacity.updated": "#3b82f6",
  "hospital.capacity.alert": "#f97316",
  "ambulance.status.updated": "#a855f7",
  "ambulance.dispatched": "#c084fc",
  "emergency.unassigned": "#fb7185",
  "emergency.resolved": "#4ade80",
  "blood.shortage.detected": "#f43f5e",
  "power.infrastructure.at_risk": "#eab308",
  "response.plan.proposed": "#38bdf8",
  "response.plan.approved": "#6366f1",
  "response.plan.rejected": "#8b9bb3",
  "response.plan.completed": "#22c55e",
  "response.plan.expired": "#8b9bb3",
  "response.plan.rolled_back": "#a78bfa",
  "command.ambulance.dispatch": "#818cf8",
  "command.ambulance.stand-down": "#818cf8",
  "command.blood.reserve": "#818cf8",
  "command.blood.release": "#818cf8",
  "command.disaster.widen-radius": "#818cf8",
  "command.succeeded": "#4ade80",
  "command.failed": "#ef4444",
});

export const eventLabel = (type) => EVENT_LABELS[type] || String(type || "unknown event");
export const eventColor = (type) => EVENT_COLORS[type] || "#94a3b8";

/**
 * True for a well-formed event envelope. The feed is server-generated, but
 * a malformed frame (or a null published by a buggy producer) must not
 * crash the page that renders it.
 */
export function isEventEnvelope(evt) {
  return Boolean(evt) && typeof evt === "object" && typeof evt.eventId === "string" && typeof evt.eventType === "string";
}

/**
 * Merges events into a feed (oldest → newest), dropping duplicates by
 * eventId and keeping at most `max`. Used both for the REST bootstrap and
 * for each live frame, so a bootstrap that finishes AFTER the first live
 * events arrive no longer throws those events away (or duplicates them).
 */
export function mergeEvents(existing, incoming, max) {
  const seen = new Set();
  const all = [...existing, ...incoming].filter((e) => {
    if (!isEventEnvelope(e) || seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
  all.sort((a, b) => (Date.parse(a.occurredAt) || 0) - (Date.parse(b.occurredAt) || 0));
  return all.slice(-max);
}

/** Formats an event time, tolerating a missing/invalid timestamp. */
export function eventTime(evt) {
  const t = Date.parse(evt?.occurredAt);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleTimeString();
}
