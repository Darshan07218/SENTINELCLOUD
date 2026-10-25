import { QUEUES, ROUTING_KEYS, DEFAULT_REACTION_RADIUS_KM } from "../events/eventTypes.js";

/**
 * Phase 7 reaction: "Hospital Service checks nearby hospitals and
 * reports available capacity" (per the phase spec). Binds
 * q.hospital.disaster-events to disaster.detected/disaster.updated;
 * on either, runs the SAME "near a point" geo query the REST API
 * already exposes at GET /hospitals/near (hospitalService.findHospitalsNear),
 * then publishes hospital.capacity.updated with the disaster's own id
 * as correlationId — this is the event-driven reaction the disaster
 * aggregator (see disaster-service/src/consumers/reactionConsumer.js)
 * and the live dashboard are both listening for.
 *
 * Deliberately reuses findHospitalsNear rather than a bespoke
 * "disaster reaction" query: it's the same real-world question
 * ("which hospitals are near this point, and how much capacity do
 * they have right now") whether asked by an operator through the REST
 * API or triggered automatically by a disaster event — one code path,
 * two ways to invoke it. This is also why no new DB migration was
 * needed for this reaction: it doesn't create or store anything new
 * in hospital_db, it just answers the same question a different way.
 */
export function registerDisasterConsumer({ consumeQueue, assertQueueAndBind, hospitalService, publishEvent }) {
  return async function start() {
    await assertQueueAndBind(QUEUES.HOSPITAL_DISASTER_EVENTS, [ROUTING_KEYS.DISASTER_DETECTED, ROUTING_KEYS.DISASTER_UPDATED]);
    await consumeQueue(QUEUES.HOSPITAL_DISASTER_EVENTS, async (envelope) => {
      const { eventType, payload } = envelope;
      // Phase 12: messages on the bus are input like any other. Drop events
      // whose fields are missing or out of range instead of running an
      // unbounded radius query or publishing a reaction for garbage.
      const problem = invalidDisasterPayload(payload);
      if (problem) {
        console.warn(`[hospital-service] dropping ${String(eventType).slice(0, 60)} event: ${problem}`);
        return;
      }
      const disasterId = payload.disasterId;
      const radiusKm = payload.radiusKm || DEFAULT_REACTION_RADIUS_KM;

      console.log(`[hospital-service] reacting to ${eventType} for disaster ${disasterId} (${payload.type}, ${payload.severity})`);

      const nearbyHospitals = await hospitalService.findHospitalsNear(payload.latitude, payload.longitude, radiusKm);

      const totalAvailableBeds = nearbyHospitals.reduce((sum, h) => sum + h.availableBeds, 0);
      const totalAvailableIcuBeds = nearbyHospitals.reduce((sum, h) => sum + h.availableIcuBeds, 0);
      const totalAvailableVentilators = nearbyHospitals.reduce((sum, h) => sum + h.availableVentilators, 0);

      // Phase 20: each hospital's 24 h forecast, so the response engine can
      // avoid sending patients to one that is about to fill up. A forecast
      // that fails is left out; it never blocks the reaction itself.
      const forecasts = new Map();
      await Promise.all(
        nearbyHospitals.map(async (h) => {
          try {
            const f = await hospitalService.forecastCapacity(h.id, { horizonHours: 24 });
            if (f) forecasts.set(h.id, { risk: f.risk, bedsPredictedPct: f.beds.predictedPct, hoursToFull: f.beds.hoursToThreshold });
          } catch (err) {
            console.warn(`[hospital-service] forecast for ${h.id} unavailable for the disaster reaction: ${err.message}`);
          }
        })
      );

      await publishEvent(
        ROUTING_KEYS.HOSPITAL_CAPACITY_UPDATED,
        {
          disasterId,
          searchRadiusKm: radiusKm,
          nearbyHospitalCount: nearbyHospitals.length,
          totalAvailableBeds,
          totalAvailableIcuBeds,
          totalAvailableVentilators,
          nearbyHospitals: nearbyHospitals.map((h) => ({
            id: h.id,
            name: h.name,
            distanceKm: h.distanceKm,
            availableBeds: h.availableBeds,
            availableIcuBeds: h.availableIcuBeds,
            availableVentilators: h.availableVentilators,
            emergencyStatus: h.emergencyStatus,
            forecast: forecasts.get(h.id) || null,
          })),
        },
        disasterId // correlationId — ties this reaction back to the disaster that triggered it
      );

      console.log(`[hospital-service] published hospital.capacity.updated for disaster ${disasterId}: ${nearbyHospitals.length} hospitals within ${radiusKm}km`);
    });
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REACTION_RADIUS_KM = 500;

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
