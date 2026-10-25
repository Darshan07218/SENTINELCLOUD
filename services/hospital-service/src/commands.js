/**
 * Phase 15 — executing command events from response-service
 * (docs/PHASE-15-RESPONSE-ENGINE.md §3).
 *
 * Commands arrive at least once (outbox + retries), but their effect must
 * happen once: dispatching ambulances twice for one approval would be wrong.
 * So every command id is recorded in `processed_commands` together with its
 * reply. A redelivered command doesn't run again; its stored reply is sent
 * again instead (the first reply may be the thing that got lost).
 *
 * Replies are `command.succeeded` / `command.failed` events, written through
 * the outbox, with the command id as correlationId.
 *
 * Canonical copy: shared/node-broker/commands.js, synced into the services
 * that execute commands (scripts/sync-shared-broker.ps1 / .sh).
 */
import { withTransaction } from "./db/transaction.js";

/** The only service allowed to send commands. */
export const COMMAND_SOURCE = "response-service";
export const REPLY_SUCCEEDED = "command.succeeded";
export const REPLY_FAILED = "command.failed";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A business outcome ("no such disaster", "already resolved"): replied as command.failed, not retried. */
export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * True if `err` is the command's fault (bad input, conflict) rather than a
 * fault of ours (database down). The services' own 4xx errors count too, so
 * existing service code can be reused as-is.
 */
export function isCommandFailure(err) {
  return err instanceof CommandError || (err && err.statusCode >= 400 && err.statusCode < 500);
}

/**
 * @param pool    pg Pool of the executing service (must have processed_commands + outbox)
 * @param outbox  the service's outbox (createOutbox)
 * @returns process(envelope, execute) — call it from the command queue's handler.
 *   execute(payload) returns the result object, or throws (see isCommandFailure).
 *   Any other error propagates, so the message is retried / dead-lettered.
 */
export function createCommandProcessor({ pool, outbox, log = console }) {
  async function sendReply(queryable, { command, commandId, planId, outcome, body }) {
    const payload = outcome === "succeeded"
      ? { commandId, command, planId, result: body }
      : { commandId, command, planId, error: body };
    await outbox.enqueue(queryable, outcome === "succeeded" ? REPLY_SUCCEEDED : REPLY_FAILED, payload, commandId);
  }

  return async function processCommand(envelope, execute) {
    const { sourceService, payload, eventType } = envelope;
    // Commands change real resources: only response-service may send them.
    if (sourceService !== COMMAND_SOURCE) {
      log.warn(`[commands] ignoring ${String(eventType).slice(0, 60)} from '${String(sourceService).slice(0, 40)}' (only ${COMMAND_SOURCE} may send commands)`);
      return { ignored: true };
    }
    if (!payload || typeof payload !== "object" || !UUID_RE.test(String(payload.commandId))) {
      log.warn(`[commands] ignoring ${String(eventType).slice(0, 60)} without a UUID commandId`);
      return { ignored: true };
    }
    const { commandId } = payload;
    const planId = UUID_RE.test(String(payload.planId)) ? payload.planId : null;

    const prior = await pool.query("SELECT outcome, result FROM processed_commands WHERE command_id = $1", [commandId]);
    if (prior.rows[0]) {
      const { outcome, result } = prior.rows[0];
      await sendReply(pool, { command: eventType, commandId, planId, outcome, body: parseJson(result) });
      outbox.kick();
      return { duplicate: true, outcome };
    }

    let outcome;
    let body;
    try {
      body = await execute(payload);
      outcome = "succeeded";
    } catch (err) {
      if (!isCommandFailure(err)) throw err; // our fault: retry, then dead-letter
      outcome = "failed";
      body = { code: err.code || "COMMAND_FAILED", message: String(err.message).slice(0, 500) };
    }

    await withTransaction(pool, async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO processed_commands (command_id, command, outcome, result)
         VALUES ($1, $2, $3, $4) ON CONFLICT (command_id) DO NOTHING`,
        [commandId, eventType, outcome, JSON.stringify(body ?? null)]
      );
      // rowCount 0: another replica finished the same command at the same
      // moment and already queued the reply.
      if (rowCount) await sendReply(client, { command: eventType, commandId, planId, outcome, body });
    });
    outbox.kick();
    return { outcome, result: body };
  };
}

function parseJson(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}
