import { haversineDistanceKm, boundingBoxForRadius } from "./geo.js";
import { ROUTING_KEYS, DISASTER_STATUS_TRANSITIONS } from "../events/eventTypes.js";

function conflictError(message, code) {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = code;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  err.code = "NOT_FOUND";
  return err;
}

/**
 * The heart of Phase 7: creating a disaster publishes DISASTER_DETECTED
 * to the broker (docs/ARCHITECTURE.md section 4). This is the ONE
 * place in the whole system that routing key gets published from —
 * every other service only ever REACTS to it. correlationId is the
 * disaster's own id, so every reaction event four other services
 * publish in response can be grouped back into one situation report
 * (see services/situationReportService.js) with nothing more than "do
 * these correlationIds match" — no synchronous call, no shared table,
 * just a shared id carried on every message.
 *
 * Publishing is best-effort in the same sense every other service's
 * publishIfAlertWorthy-style helper is: the disaster record itself
 * must persist even if RabbitMQ is momentarily unreachable. But unlike
 * a routine capacity update, a disaster with NO reaction fan-out is a
 * much bigger problem for this system's whole premise — so a publish
 * failure here is logged at error level (not warn) and surfaced back
 * to the caller as a response field (`eventPublished: false`) rather
 * than silently swallowed, so an operator creating a real disaster
 * during a live demo immediately knows the event didn't go out.
 *
 * Phase 14: with an `outbox` and `transaction` (see index.js), the change
 * and its event are written in ONE database transaction, and the outbox
 * relay delivers the event — after a RabbitMQ outage too. `eventPublished`
 * then means "safely queued for delivery" and is true whenever the request
 * succeeds. Without them (unit tests), it publishes directly as before.
 */
export function createDisasterService({ disasterRepository, publishEvent, outbox, transaction }) {
  function eventPayload(disaster) {
    return {
      disasterId: disaster.id,
      type: disaster.type,
      severity: disaster.severity,
      latitude: disaster.latitude,
      longitude: disaster.longitude,
      radiusKm: disaster.radiusKm,
      description: disaster.description,
      status: disaster.status,
      statusNote: disaster.statusNote ?? null,
      occurredAt: disaster.occurredAt,
    };
  }

  async function publish(routingKey, disaster) {
    if (!publishEvent) return false;
    try {
      await publishEvent(routingKey, eventPayload(disaster), disaster.id /* correlationId */);
      return true;
    } catch (err) {
      console.error(`[disaster-service] FAILED to publish ${routingKey} for disaster ${disaster.id}:`, err.message);
      return false;
    }
  }

  /**
   * Runs write(repository) and records the event for its result. With the
   * outbox: both in one transaction, then the relay is kicked. `routingKeyFor`
   * picks the key from the written row; returning null means "no event".
   */
  async function writeAndEmit(write, routingKeyFor) {
    if (outbox && transaction) {
      const disaster = await transaction(async ({ disasterRepository: repo, client }) => {
        const row = await write(repo);
        if (row) await outbox.enqueue(client, routingKeyFor(row), eventPayload(row), row.id);
        return row;
      });
      if (disaster) outbox.kick();
      return { disaster, eventPublished: Boolean(disaster) };
    }
    const disaster = await write(disasterRepository);
    return { disaster, eventPublished: disaster ? await publish(routingKeyFor(disaster), disaster) : false };
  }

  return {
    async createDisaster(data, createdByUserId) {
      return writeAndEmit((repo) => repo.create(data, createdByUserId), () => ROUTING_KEYS.DISASTER_DETECTED);
    },

    async getDisaster(id) {
      const disaster = await disasterRepository.findById(id);
      if (!disaster) throw notFoundError("Disaster not found.");
      return disaster;
    },

    async listDisasters(query) {
      const { disasters, total } = await disasterRepository.list(query);
      return {
        disasters,
        pagination: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
      };
    },

    async listActiveDisasters() {
      return disasterRepository.listActive();
    },

    async findDisastersNear(lat, lng, radiusKm) {
      const box = boundingBoxForRadius(lat, lng, radiusKm);
      const candidates = await disasterRepository.findWithinBoundingBox(box);
      return candidates
        .map((d) => ({ ...d, distanceKm: Math.round(haversineDistanceKm(lat, lng, d.latitude, d.longitude) * 10) / 10 }))
        .filter((d) => d.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm);
    },

    /**
     * Updates severity/radius/description on an already-detected
     * disaster and republishes DISASTER_UPDATED so every reacting
     * service can recompute (e.g. a widened radiusKm means Hospital
     * Service should search a bigger area on its next reaction cycle
     * — for this phase's scope, a fresh DISASTER_UPDATED simply
     * triggers the same reaction logic as DISASTER_DETECTED again;
     * see each service's disasterConsumer.js, which handles both
     * routing keys identically).
     */
    async updateDisaster(id, fields) {
      const existing = await disasterRepository.findById(id);
      if (!existing) throw notFoundError("Disaster not found.");
      if (existing.status === "RESOLVED") {
        throw conflictError("This disaster is RESOLVED; its details can no longer be changed.", "DISASTER_RESOLVED");
      }
      return writeAndEmit((repo) => repo.updateFields(id, fields), () => ROUTING_KEYS.DISASTER_UPDATED);
    },

    async setStatus(id, status, note) {
      const existing = await disasterRepository.findById(id);
      if (!existing) throw notFoundError("Disaster not found.");
      const allowed = DISASTER_STATUS_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(status)) {
        throw conflictError(
          `Cannot change a ${existing.status} disaster to ${status}. Allowed: ${allowed.join(", ") || "(none — RESOLVED is final)"}.`,
          "INVALID_STATUS_TRANSITION"
        );
      }
      // ACTIVE/CONTAINED changes still matter to the reacting services
      // (disaster.updated → fresh reactions). Resolution doesn't: it is
      // announced once on disaster.resolved for the live feed only.
      const routingKey = status === "RESOLVED" ? ROUTING_KEYS.DISASTER_RESOLVED : ROUTING_KEYS.DISASTER_UPDATED;
      const result = await writeAndEmit((repo) => repo.setStatus(id, status, { fromStatus: existing.status, note }), () => routingKey);
      if (!result.disaster) {
        throw conflictError("The disaster's status was changed by another request. Reload and try again.", "CONCURRENT_UPDATE");
      }
      return result;
    },
  };
}
