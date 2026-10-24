import { COMMANDS, QUEUES } from "../events/eventTypes.js";
import { CommandError } from "../commands.js";

/** Escalation never widens a disaster's search radius past this (km). */
export const MAX_ESCALATED_RADIUS_KM = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 15: executes response-service's escalation command
 * (docs/PHASE-15-RESPONSE-ENGINE.md §2–3).
 *
 * command.disaster.widen-radius uses the same update path as an operator's
 * PUT /disasters/{id}: the new radius and its disaster.updated event commit
 * together (outbox), and the four reacting services search the wider area.
 * Only ever widens: a request that isn't larger than the current radius is a
 * no-op success, so replays and stale commands can't shrink it.
 */
export function createDisasterCommandHandlers({ disasterService }) {
  async function widenRadius(payload) {
    const { disasterId, radiusKm } = payload;
    if (!UUID_RE.test(String(disasterId))) throw new CommandError("INVALID_COMMAND", "disasterId must be a UUID");
    if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > MAX_ESCALATED_RADIUS_KM) {
      throw new CommandError("INVALID_COMMAND", `radiusKm must be in (0, ${MAX_ESCALATED_RADIUS_KM}]`);
    }
    // 404 / 409 DISASTER_RESOLVED from the service become command.failed (commands.js).
    const current = await disasterService.getDisaster(disasterId);
    if (current.radiusKm >= radiusKm) {
      return { disasterId, radiusKm: current.radiusKm, changed: false };
    }
    const { disaster } = await disasterService.updateDisaster(disasterId, { radiusKm });
    return { disasterId, previousRadiusKm: current.radiusKm, radiusKm: disaster.radiusKm, changed: true };
  }

  return { [COMMANDS.DISASTER_WIDEN_RADIUS]: widenRadius };
}

export function registerCommandConsumer({ consumeQueue, assertQueueAndBind, processCommand, handlers }) {
  return async function start() {
    await assertQueueAndBind(QUEUES.DISASTER_COMMANDS, Object.keys(handlers));
    await consumeQueue(QUEUES.DISASTER_COMMANDS, async (envelope) => {
      const handler = handlers[envelope.eventType];
      if (!handler) {
        console.warn(`[disaster-service] ignoring unknown command ${String(envelope.eventType).slice(0, 60)}`);
        return;
      }
      const outcome = await processCommand(envelope, handler);
      if (!outcome.ignored) {
        console.log(`[disaster-service] ${envelope.eventType} ${envelope.payload.commandId}: ${outcome.duplicate ? "duplicate, reply resent" : outcome.outcome}`);
      }
    });
  };
}
