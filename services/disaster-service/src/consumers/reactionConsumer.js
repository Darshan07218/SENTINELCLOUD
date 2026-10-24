import { QUEUES, REACTION_ROUTING_KEYS } from "../events/eventTypes.js";

/**
 * The fan-in half of the pub/sub pattern: binds
 * q.disaster.reaction-aggregator to the four reaction routing keys
 * (hospital.capacity.updated, ambulance.status.updated,
 * blood.shortage.detected, power.infrastructure.at_risk) and stores
 * each one keyed by its correlationId (the disaster's own id) via
 * reactionRepository.upsert(). This is what lets
 * GET /disasters/:id/situation-report answer "what has every service
 * said about this disaster" without a single synchronous call.
 *
 * correlationId is expected to be set (every reaction-publishing
 * consumer in this project sets it to the disasterId it reacted to —
 * see each service's disasterConsumer.js). A reaction event that
 * somehow arrives without one (e.g. a modified message injected by
 * hand) is logged and dropped rather than crashing the aggregator or
 * being stored against a nonexistent disaster.
 */
export function registerReactionConsumer({ consumeQueue, assertQueueAndBind, reactionRepository }) {
  return async function start() {
    await assertQueueAndBind(QUEUES.DISASTER_REACTION_AGGREGATOR, REACTION_ROUTING_KEYS);
    await consumeQueue(QUEUES.DISASTER_REACTION_AGGREGATOR, async (envelope) => {
      const { eventType, sourceService, eventId, correlationId, payload, occurredAt } = envelope;
      if (!correlationId) {
        console.warn(`[disaster-service] reaction event ${String(eventType).slice(0, 60)} has no correlationId — dropping`);
        return;
      }
      // Phase 12: only store reactions that look like what the four reacting
      // services publish — a known event type from a known service, for a
      // UUID disaster id — so a malformed or injected message can't write
      // arbitrary rows into the situation report.
      if (!REACTION_ROUTING_KEYS.includes(eventType) || !REACTION_SOURCES.has(sourceService) || !UUID_RE.test(String(correlationId))) {
        console.warn(`[disaster-service] dropping unexpected reaction event (type/source/correlationId not recognised)`);
        return;
      }
      if (!payload || typeof payload !== "object" || !UUID_RE.test(String(eventId))) {
        console.warn(`[disaster-service] dropping ${eventType} reaction with no payload or a non-UUID eventId`);
        return;
      }
      const occurred = typeof occurredAt === "string" && !Number.isNaN(Date.parse(occurredAt)) ? occurredAt : null;
      const stored = await reactionRepository.upsert({
        disasterId: correlationId,
        eventType,
        sourceService,
        eventId,
        payload,
        occurredAt: occurred,
      });
      if (!stored) {
        console.log(`[disaster-service] ignored out-of-order ${eventType} from ${sourceService} for disaster ${correlationId} (a newer one is stored)`);
        return;
      }
      console.log(`[disaster-service] recorded reaction ${eventType} from ${sourceService} for disaster ${correlationId}`);
    });
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REACTION_SOURCES = new Set(["hospital-service", "ambulance-service", "blood-bank-service", "power-service"]);
