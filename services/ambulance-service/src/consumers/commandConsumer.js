import { COMMANDS, QUEUES } from "../events/eventTypes.js";
import { CommandError } from "../commands.js";

/** Most emergencies one dispatch command may create (the playbook asks for at most 9). */
export const MAX_DISPATCH_COUNT = 10;
const SEVERITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Auto-approved plans have no human approver; their emergencies are recorded
// against this fixed "system" user id.
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Phase 15: executes response-service's ambulance commands
 * (docs/PHASE-15-RESPONSE-ENGINE.md §3) with the SAME code paths operators
 * use, so a plan dispatches exactly the way a human would:
 *
 *  - command.ambulance.dispatch: create `count` emergency calls at the
 *    disaster's location, each auto-dispatched to the nearest free ambulance
 *    (dispatchService.dispatchForNewEmergency). A call that finds no free
 *    ambulance stays ACTIVE for operators. Each call is tagged with the
 *    command id, so a retry after a crash only creates the missing ones.
 *  - command.ambulance.stand-down (undo): cancel those calls, which frees
 *    their ambulances (dispatchService.cancelEmergency).
 *
 * processCommand (commands.js) makes each command's effect happen once and
 * sends the reply.
 */
export function createAmbulanceCommandHandlers({ emergencyRepository, dispatchService }) {
  async function dispatch(payload) {
    const { disasterId, latitude, longitude, count, severity, description, requestedBy } = payload;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new CommandError("INVALID_COMMAND", "latitude/longitude out of range");
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_DISPATCH_COUNT) {
      throw new CommandError("INVALID_COMMAND", `count must be 1..${MAX_DISPATCH_COUNT}`);
    }
    const createdBy = UUID_RE.test(String(requestedBy)) ? requestedBy : SYSTEM_USER_ID;
    const callSeverity = SEVERITIES.has(severity) ? severity : "HIGH";
    const text = `Disaster response${disasterId ? ` (disaster ${String(disasterId).slice(0, 8)})` : ""}: ${String(description || "unit requested by response plan").slice(0, 200)}`;

    const existing = await emergencyRepository.findByCommand(payload.commandId);
    for (let i = existing.length; i < count; i++) {
      const emergency = await emergencyRepository.createForCommand(
        { description: text, latitude, longitude, severity: callSeverity },
        createdBy,
        payload.commandId
      );
      await dispatchService.dispatchForNewEmergency(emergency);
    }

    const calls = await emergencyRepository.findByCommand(payload.commandId);
    const dispatched = calls.filter((e) => e.assignedAmbulanceId).map((e) => ({ emergencyId: e.id, ambulanceId: e.assignedAmbulanceId }));
    return {
      emergencyIds: calls.map((e) => e.id),
      dispatched,
      dispatchedCount: dispatched.length,
      // Calls left ACTIVE for operators: no free ambulance was in range.
      unassignedCount: calls.length - dispatched.length,
    };
  }

  async function standDown(payload) {
    const ids = Array.isArray(payload.emergencyIds) ? payload.emergencyIds.filter((id) => UUID_RE.test(String(id))) : [];
    if (ids.length === 0) throw new CommandError("INVALID_COMMAND", "emergencyIds must list at least one emergency id");
    const cancelled = [];
    const alreadyClosed = [];
    for (const id of ids.slice(0, 50)) {
      try {
        const result = await dispatchService.cancelEmergency(id);
        (result ? cancelled : alreadyClosed).push(id); // null = no such emergency
      } catch (err) {
        if (err.code !== "EMERGENCY_ALREADY_CLOSED") throw err;
        alreadyClosed.push(id); // resolved or cancelled meanwhile: nothing to undo
      }
    }
    return { cancelled, alreadyClosed };
  }

  return {
    [COMMANDS.AMBULANCE_DISPATCH]: dispatch,
    [COMMANDS.AMBULANCE_STAND_DOWN]: standDown,
  };
}

export function registerCommandConsumer({ consumeQueue, assertQueueAndBind, processCommand, handlers }) {
  return async function start() {
    await assertQueueAndBind(QUEUES.AMBULANCE_COMMANDS, Object.keys(handlers));
    await consumeQueue(QUEUES.AMBULANCE_COMMANDS, async (envelope) => {
      const handler = handlers[envelope.eventType];
      if (!handler) {
        console.warn(`[ambulance-service] ignoring unknown command ${String(envelope.eventType).slice(0, 60)}`);
        return;
      }
      const outcome = await processCommand(envelope, handler);
      if (!outcome.ignored) {
        console.log(`[ambulance-service] ${envelope.eventType} ${envelope.payload.commandId}: ${outcome.duplicate ? "duplicate, reply resent" : outcome.outcome}`);
      }
    });
  };
}
