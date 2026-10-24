/**
 * Canonical event schema for the SentinelCloud event bus — matches
 * docs/ARCHITECTURE.md section 4 exactly. Every service that publishes
 * or consumes events imports its routing keys from a copy of this file
 * (duplicated per-service rather than shared as an npm package, same
 * "no shared runtime code between services" philosophy the rest of
 * this project already follows for database-per-service — a Node
 * monorepo package would blur the deployment boundary between
 * independently-deployable services).
 */

export const EXCHANGE_NAME = "sentinelcloud.events";

export const ROUTING_KEYS = Object.freeze({
  DISASTER_DETECTED: "disaster.detected",
  DISASTER_UPDATED: "disaster.updated",
  // Engineering review: closing a disaster is announced on its own key.
  // Only notification-service ("#") receives it — re-running every
  // service's radius search for a disaster that is over was pure load.
  DISASTER_RESOLVED: "disaster.resolved",
  HOSPITAL_CAPACITY_UPDATED: "hospital.capacity.updated",
  AMBULANCE_STATUS_UPDATED: "ambulance.status.updated",
  BLOOD_SHORTAGE_DETECTED: "blood.shortage.detected",
  POWER_INFRASTRUCTURE_AT_RISK: "power.infrastructure.at_risk",
  // Engineering review: every key actually published on the bus is listed
  // here (these five only go to notification-service's "#" binding).
  HOSPITAL_CAPACITY_ALERT: "hospital.capacity.alert",
  AMBULANCE_DISPATCHED: "ambulance.dispatched",
  EMERGENCY_UNASSIGNED: "emergency.unassigned",
  EMERGENCY_RESOLVED: "emergency.resolved",
});

/** Every routing key a disaster-reaction event can arrive under — used by the aggregator and the notification gateway. */
export const REACTION_ROUTING_KEYS = Object.freeze([
  ROUTING_KEYS.HOSPITAL_CAPACITY_UPDATED,
  ROUTING_KEYS.AMBULANCE_STATUS_UPDATED,
  ROUTING_KEYS.BLOOD_SHORTAGE_DETECTED,
  ROUTING_KEYS.POWER_INFRASTRUCTURE_AT_RISK,
]);

/** Phase 15: commands from response-service (docs/PHASE-15-RESPONSE-ENGINE.md §3). */
export const COMMANDS = Object.freeze({
  DISASTER_WIDEN_RADIUS: "command.disaster.widen-radius",
});

export const QUEUES = Object.freeze({
  DISASTER_COMMANDS: "q.disaster.commands",
  HOSPITAL_DISASTER_EVENTS: "q.hospital.disaster-events",
  AMBULANCE_DISASTER_EVENTS: "q.ambulance.disaster-events",
  BLOODBANK_DISASTER_EVENTS: "q.bloodbank.disaster-events",
  POWER_DISASTER_EVENTS: "q.power.disaster-events",
  DISASTER_REACTION_AGGREGATOR: "q.disaster.reaction-aggregator",
  NOTIFICATIONS_ALL_EVENTS: "q.notifications.all-events",
});

export const DISASTER_TYPES = Object.freeze([
  "FLOOD",
  "FIRE",
  "EARTHQUAKE",
  "CYCLONE",
  "LANDSLIDE",
  "INDUSTRIAL_ACCIDENT",
]);

export const SEVERITIES = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

/**
 * ACTIVE: currently unfolding, reactions are being generated.
 * CONTAINED: no longer worsening, response is ongoing (declared by an
 *   EMERGENCY_OPERATOR — not inferred automatically).
 * RESOLVED: closed out; retained for the historical record but no
 *   longer shown in the "active disasters" view the dashboard defaults to.
 */
export const DISASTER_STATUSES = Object.freeze(["ACTIVE", "CONTAINED", "RESOLVED"]);

/**
 * Legal status changes. RESOLVED is final (re-opening a closed incident
 * means reporting a new one); CONTAINED can flare up again to ACTIVE.
 */
export const DISASTER_STATUS_TRANSITIONS = Object.freeze({
  ACTIVE: Object.freeze(["CONTAINED", "RESOLVED"]),
  CONTAINED: Object.freeze(["ACTIVE", "RESOLVED"]),
  RESOLVED: Object.freeze([]),
});

/** Default search radius (km) used when reacting to a disaster if the event itself didn't specify one. */
export const DEFAULT_REACTION_RADIUS_KM = 25;
