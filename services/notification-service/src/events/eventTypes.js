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
  DISASTER_RESOLVED: "disaster.resolved",
});

/** Every routing key a disaster-reaction event can arrive under — used by the aggregator and the notification gateway. */
export const REACTION_ROUTING_KEYS = Object.freeze([
  ROUTING_KEYS.HOSPITAL_CAPACITY_UPDATED,
  ROUTING_KEYS.AMBULANCE_STATUS_UPDATED,
  ROUTING_KEYS.BLOOD_SHORTAGE_DETECTED,
  ROUTING_KEYS.POWER_INFRASTRUCTURE_AT_RISK,
]);

export const QUEUES = Object.freeze({
  HOSPITAL_DISASTER_EVENTS: "q.hospital.disaster-events",
  AMBULANCE_DISASTER_EVENTS: "q.ambulance.disaster-events",
  BLOODBANK_DISASTER_EVENTS: "q.bloodbank.disaster-events",
  POWER_DISASTER_EVENTS: "q.power.disaster-events",
  DISASTER_REACTION_AGGREGATOR: "q.disaster.reaction-aggregator",
  NOTIFICATIONS_ALL_EVENTS: "q.notifications.all-events",
  // Phase 9: prefix for the per-replica live-broadcast queue
  // (q.notifications.live.<pod-name>) — see notification-service/src/index.js.
  NOTIFICATIONS_LIVE_PREFIX: "q.notifications.live.",
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

/** Default search radius (km) used when reacting to a disaster if the event itself didn't specify one. */
export const DEFAULT_REACTION_RADIUS_KM = 25;
