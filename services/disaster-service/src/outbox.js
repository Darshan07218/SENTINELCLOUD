/**
 * Phase 14 — transactional outbox (docs/PHASE-14-RELIABLE-EVENTS.md §2.1).
 *
 * Problem: a service saves a change and then publishes its event. If RabbitMQ
 * is down, or the process dies in between, the change exists and the event
 * never goes out.
 *
 * Fix: the event is INSERTed into this service's `outbox` table in the SAME
 * database transaction as the change, so both are saved or neither is. A
 * relay then sends unsent rows to RabbitMQ (publisher confirms) and marks
 * them sent:
 *   - right after each enqueue (kick), so the normal delay stays tiny;
 *   - every SWEEP_INTERVAL_MS, to catch up after a RabbitMQ outage or crash.
 * Rows are claimed with FOR UPDATE SKIP LOCKED, so several replicas never
 * send the same row at once. Delivery is at-least-once: a crash between the
 * broker's confirm and the UPDATE resends the row, and consumers tolerate
 * duplicates (§2.4).
 *
 * Canonical copy: shared/node-broker/outbox.js, synced into the services that
 * use it like broker.js.
 */
import { buildEnvelope, publishEnvelope } from "./broker.js";
import { registry } from "./metrics.js";

export const SWEEP_INTERVAL_MS = 2000;
export const BATCH_SIZE = 50;
const RETENTION_DAYS = 7;
const CLEANUP_EVERY_N_SWEEPS = 1800; // about once an hour at 2 s

// One outbox per process; the metrics read whichever pool was started last.
let metricsPool = null;
const publishFailures = registry.counter(
  "sentinel_outbox_publish_failures_total",
  "Outbox rows the relay tried to send and RabbitMQ didn't confirm (they stay queued and are retried)."
);
registry.gauge("sentinel_outbox_pending", "Events saved in the outbox and not yet confirmed by RabbitMQ.", [], {
  collect: async () => {
    if (!metricsPool) return [];
    const { rows } = await metricsPool.query("SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL");
    return [{ value: rows[0].n }];
  },
});

/**
 * @param pool        pg Pool (relay + pool-level enqueue)
 * @param publish     (routingKey, envelope) => Promise — defaults to broker.publishEnvelope
 * @param log         defaults to console
 */
export function createOutbox({ pool, publish = publishEnvelope, log = console, intervalMs = SWEEP_INTERVAL_MS, batchSize = BATCH_SIZE }) {
  let timer = null;
  let running = false; // one relay pass at a time per process
  let again = false; // a kick arrived during a pass: run once more after it
  let sweeps = 0;

  /**
   * Stores one event with `queryable` — a transaction's client, so it commits
   * or rolls back with the change, or the pool for a standalone event.
   * Returns the envelope (its eventId is final).
   */
  async function enqueue(queryable, routingKey, payload, correlationId) {
    const envelope = buildEnvelope(routingKey, payload, correlationId);
    await queryable.query(
      `INSERT INTO outbox (event_id, routing_key, envelope) VALUES ($1, $2, $3)`,
      [envelope.eventId, routingKey, JSON.stringify(envelope)]
    );
    return envelope;
  }

  /**
   * Sends up to batchSize unsent rows, oldest first, inside one transaction
   * that holds their row locks. Stops at the first failure so a service's
   * events stay in order; the failed row keeps its place and is retried on
   * the next pass. Returns the number of rows sent.
   */
  async function relayOnce() {
    const client = await pool.connect();
    let sent = 0;
    let broken = null;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, routing_key, envelope FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );
      for (const row of rows) {
        const envelope = typeof row.envelope === "string" ? JSON.parse(row.envelope) : row.envelope;
        try {
          await publish(row.routing_key, envelope);
        } catch (err) {
          publishFailures.inc();
          await client.query(`UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [row.id, String(err.message).slice(0, 500)]);
          break;
        }
        await client.query(`UPDATE outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [row.id]);
        sent++;
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        broken = rollbackErr;
      }
      throw err;
    } finally {
      client.release(broken || undefined);
    }
    return sent;
  }

  /** Runs relay passes until a pass sends less than a full batch. Never throws. */
  async function drain() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        let sent;
        do {
          sent = await relayOnce();
        } while (sent === batchSize);
      } while (again);
    } catch (err) {
      log.error("[outbox] relay pass failed (rows stay queued):", err.message);
    } finally {
      running = false;
    }
  }

  async function sweep() {
    await drain();
    if (++sweeps % CLEANUP_EVERY_N_SWEEPS === 0) {
      await pool
        .query(`DELETE FROM outbox WHERE published_at < now() - make_interval(days => $1)`, [RETENTION_DAYS])
        .catch((err) => log.warn("[outbox] cleanup failed:", err.message));
    }
  }

  return {
    enqueue,
    relayOnce,
    drain,
    /** Ask the relay to send soon (after the caller's transaction committed). Never throws. */
    kick() {
      setImmediate(() => drain());
    },
    start() {
      metricsPool = pool;
      if (!timer) {
        timer = setInterval(() => sweep(), intervalMs);
        timer.unref?.();
      }
      this.kick(); // anything left from before a restart
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
