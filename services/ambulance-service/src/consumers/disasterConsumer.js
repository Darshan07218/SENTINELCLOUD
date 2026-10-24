import { QUEUES, ROUTING_KEYS, DEFAULT_REACTION_RADIUS_KM } from "../events/eventTypes.js";

/**
 * Phase 7 reaction: "Ambulance Service finds available ambulances".
 * Binds q.ambulance.disaster-events to disaster.detected/disaster.updated;
 * on either, reuses the exact same geo query the REST API already
 * exposes at GET /ambulances/near-available
 * (ambulanceService.findNearestAvailable) to find AVAILABLE ambulances
 * around the disaster's epicenter, then publishes
 * ambulance.status.updated with the disaster's id as correlationId.
 *
 * Scope note: this reports which ambulances ARE available near the
 * disaster — it does not automatically dispatch them. Actually
 * dispatching (assigning a specific ambulance to a specific
 * emergency) already exists as a deliberate human/operator action via
 * dispatchService.js and stays that way; auto-dispatching every
 * available ambulance the instant a disaster is detected would be a
 * significant, separate policy decision this phase doesn't make.
 */
export function registerDisasterConsumer({ consumeQueue, assertQueueAndBind, ambulanceService, publishEvent }) {
  return async function start() {
    await assertQueueAndBind(QUEUES.AMBULANCE_DISASTER_EVENTS, [ROUTING_KEYS.DISASTER_DETECTED, ROUTING_KEYS.DISASTER_UPDATED]);
    await consumeQueue(QUEUES.AMBULANCE_DISASTER_EVENTS, async (envelope) => {
      const { eventType, payload } = envelope;
      // Phase 12: messages on the bus are input like any other. Drop events
      // whose fields are missing or out of range instead of running an
      // unbounded radius query or publishing a reaction for garbage.
      const problem = invalidDisasterPayload(payload);
      if (problem) {
        console.warn(`[ambulance-service] dropping ${String(eventType).slice(0, 60)} event: ${problem}`);
        return;
      }
      const disasterId = payload.disasterId;
      const radiusKm = payload.radiusKm || DEFAULT_REACTION_RADIUS_KM;

      console.log(`[ambulance-service] reacting to ${eventType} for disaster ${disasterId} (${payload.type}, ${payload.severity})`);

      // Count every available ambulance in range, but only list the
      // nearest REACTION_LIST_LIMIT in the event (keeps messages small).
      const availableAmbulances = await ambulanceService.findNearestAvailable(payload.latitude, payload.longitude, {
        radiusKm,
        limit: Number.MAX_SAFE_INTEGER,
      });

      await publishEvent(
        ROUTING_KEYS.AMBULANCE_STATUS_UPDATED,
        {
          disasterId,
          searchRadiusKm: radiusKm,
          availableAmbulanceCount: availableAmbulances.length,
          availableAmbulances: availableAmbulances.slice(0, REACTION_LIST_LIMIT).map((a) => ({
            id: a.id,
            vehicleNumber: a.vehicleNumber,
            equipmentLevel: a.equipmentLevel,
            distanceKm: a.distanceKm,
            etaMinutes: a.etaMinutes,
          })),
        },
        disasterId
      );

      console.log(`[ambulance-service] published ambulance.status.updated for disaster ${disasterId}: ${availableAmbulances.length} ambulances available within ${radiusKm}km`);
    });
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REACTION_RADIUS_KM = 500;
const REACTION_LIST_LIMIT = 20;

/** Returns a reason string if the disaster payload is unusable, else null. */
export function invalidDisasterPayload(payload) {
  if (!payload || typeof payload !== "object") return "no payload";
  if (typeof payload.disasterId !== "string" || !UUID_RE.test(payload.disasterId)) return "disasterId is not a UUID";
  const { latitude, longitude, radiusKm } = payload;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return "latitude out of range";
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return "longitude out of range";
  if (radiusKm !== undefined && radiusKm !== null && (typeof radiusKm !== "number" || !(radiusKm > 0) || radiusKm > MAX_REACTION_RADIUS_KM)) {
    return `radiusKm must be in (0, ${MAX_REACTION_RADIUS_KM}]`;
  }
  return null;
}
