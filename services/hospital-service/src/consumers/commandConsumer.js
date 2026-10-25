import { COMMANDS, QUEUES } from "../events/eventTypes.js";
import { CommandError } from "../commands.js";

/**
 * Phase 20: executes response-service's bed commands
 * (docs/PHASE-20-SMARTER-RESPONSE.md §2):
 *
 *  - command.hospital.reserve-beds: hold up to `beds` / `icuBeds` at one
 *    hospital (reservations.js); the reply says how many were actually held.
 *  - command.hospital.release-beds (undo): give a reservation's beds back.
 *
 * processCommand (commands.js) makes each command's effect happen once and
 * sends the reply; reservations.js is itself idempotent per command id for
 * a crash between the two.
 */
export function createHospitalCommandHandlers({ reservationService }) {
  // The reservation layer's 4xx errors become command failures (not retried).
  const asCommand = (fn) => async (payload) => {
    try {
      return await fn(payload);
    } catch (err) {
      if (err.statusCode >= 400 && err.statusCode < 500) throw new CommandError(err.code || "COMMAND_FAILED", err.message);
      throw err;
    }
  };

  const reserve = asCommand(async (p) => {
    const { reservation, hospitalName, duplicate } = await reservationService.reserve({
      hospitalId: p.hospitalId,
      beds: p.beds ?? 0,
      icuBeds: p.icuBeds ?? 0,
      disasterId: p.disasterId,
      planId: p.planId,
      commandId: p.commandId,
      notes: p.notes,
    });
    return {
      reservationId: reservation.id,
      hospitalId: reservation.hospitalId,
      hospitalName: hospitalName ?? null,
      reservedBeds: reservation.beds,
      reservedIcuBeds: reservation.icuBeds,
      requestedBeds: p.beds ?? 0,
      requestedIcuBeds: p.icuBeds ?? 0,
      ...(duplicate ? { duplicate: true } : {}),
    };
  });

  const release = asCommand(async (p) => {
    const { reservation, alreadyReleased } = await reservationService.release(p.reservationId);
    return { reservationId: reservation.id, releasedBeds: reservation.beds, releasedIcuBeds: reservation.icuBeds, alreadyReleased };
  });

  return {
    [COMMANDS.HOSPITAL_RESERVE_BEDS]: reserve,
    [COMMANDS.HOSPITAL_RELEASE_BEDS]: release,
  };
}

export function registerCommandConsumer({ consumeQueue, assertQueueAndBind, processCommand, handlers }) {
  return async function start() {
    await assertQueueAndBind(QUEUES.HOSPITAL_COMMANDS, Object.keys(handlers));
    await consumeQueue(QUEUES.HOSPITAL_COMMANDS, async (envelope) => {
      const handler = handlers[envelope.eventType];
      if (!handler) {
        console.warn(`[hospital-service] ignoring unknown command ${String(envelope.eventType).slice(0, 60)}`);
        return;
      }
      const outcome = await processCommand(envelope, handler);
      if (!outcome.ignored) {
        console.log(`[hospital-service] ${envelope.eventType} ${envelope.payload.commandId}: ${outcome.duplicate ? "duplicate, reply resent" : outcome.outcome}`);
      }
    });
  };
}
