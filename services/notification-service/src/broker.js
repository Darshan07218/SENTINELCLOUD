/**
 * RabbitMQ client shared by every Node service that publishes or consumes
 * domain events (hospital, ambulance, disaster, notification).
 *
 * Canonical copy: shared/node-broker/broker.js. Each service is its own
 * Docker build context, so it ships a copy in src/broker.js (synced by
 * scripts/sync-shared-broker.ps1 / .sh; tests/copies.test.js fails if one
 * drifts). The service name is read from the service's own package.json.
 *
 * Phase 14 (docs/PHASE-14-RELIABLE-EVENTS.md):
 *  - publisher confirms: publishEvent() resolves only once RabbitMQ has
 *    stored the message, and throws if it refuses or doesn't answer;
 *  - consumeQueue() retries a failing handler in place (1 s, 2 s, 4 s), then
 *    rejects the message, which a RabbitMQ policy routes to the dead-letter
 *    exchange instead of dropping it;
 *  - the dead-letter exchange and queue are declared here, on every
 *    connect, so the policy never points at a missing exchange.
 */
import amqplib from "amqplib";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { recordEventConsumed, recordEventPublished } from "./metrics.js";

const SERVICE_NAME = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .name.replace(/^@[^/]+\//, "");

// Matches the topic exchange documented in docs/EVENT-SCHEMA.md — every
// service that publishes or consumes domain events uses it, distinguished
// by routing key.
export const EXCHANGE_NAME = "sentinelcloud.events";
// Phase 14: where rejected messages go (via the "sentinel-dead-letter" policy,
// see k8s/base/infrastructure/rabbitmq.yaml). Topic, so the original routing
// key is kept and one "#" binding catches everything.
export const DEAD_LETTER_EXCHANGE = "sentinelcloud.dlx";
export const DEAD_LETTER_QUEUE = "q.dead-letters";

/** Delays before the 2nd, 3rd and 4th attempt at handling one message. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000];
const CONFIRM_TIMEOUT_MS = 5000;

let connection = null;
let channel = null;
let lastError = null;

// Phase 9: `onClose` lets index.js reconnect (and re-register its
// consumers) after RabbitMQ restarts — see connectBrokerWithRetry there.
export async function connectBroker(url, { onClose } = {}) {
  let conn = null;
  try {
    conn = await amqplib.connect(url);
    // Phase 14: a confirm channel, so every publish is acknowledged by the broker.
    const ch = await conn.createConfirmChannel();
    await ch.assertExchange(EXCHANGE_NAME, "topic", { durable: true });
    await ch.assertExchange(DEAD_LETTER_EXCHANGE, "topic", { durable: true });
    await ch.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await ch.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, "#");
    connection = conn;
    channel = ch;
    lastError = null;

    conn.on("close", () => {
      console.warn(`[${SERVICE_NAME}] RabbitMQ connection closed`);
      if (connection === conn) {
        connection = null;
        channel = null;
        if (onClose) onClose();
      }
    });
    conn.on("error", (err) => {
      console.error(`[${SERVICE_NAME}] RabbitMQ connection error:`, err.message);
      lastError = err.message;
    });
    // A channel can die on its own (e.g. a PRECONDITION_FAILED from the
    // broker) while the connection stays up. Without these listeners the
    // channel's 'error' event is unhandled (crashes the process) and
    // isBrokerConnected() keeps reporting true for a dead channel. Closing
    // the connection funnels it into the normal reconnect path above.
    ch.on("error", (err) => {
      console.error(`[${SERVICE_NAME}] RabbitMQ channel error:`, err.message);
      lastError = err.message;
    });
    ch.on("close", () => {
      if (channel === ch) {
        console.warn(`[${SERVICE_NAME}] RabbitMQ channel closed — reconnecting`);
        channel = null;
        conn.close().catch(() => {});
      }
    });

    console.log(`[${SERVICE_NAME}] connected to RabbitMQ`);
    return ch;
  } catch (err) {
    lastError = err.message;
    // createChannel/assertExchange failed after connect succeeded: don't
    // leak the half-open connection on every retry.
    if (conn) conn.close().catch(() => {});
    throw err;
  }
}

export function isBrokerConnected() {
  return Boolean(connection && channel);
}

export function getBrokerError() {
  return lastError;
}

/**
 * The canonical envelope (docs/EVENT-SCHEMA.md): eventId, eventType,
 * occurredAt, sourceService, correlationId, payload. correlationId ties a
 * disaster's whole reaction chain together — every reaction to a
 * disaster.detected carries that disaster's id — so the aggregator can group
 * "everything that happened because of disaster X" without a shared table.
 * Exported for the outbox, which stores the envelope at write time.
 */
export function buildEnvelope(routingKey, payload, correlationId) {
  return {
    eventId: randomUUID(),
    eventType: routingKey,
    occurredAt: new Date().toISOString(),
    sourceService: SERVICE_NAME,
    correlationId: correlationId || null,
    payload,
  };
}

/**
 * Publishes a ready-made envelope and resolves once RabbitMQ confirms it.
 * Throws if not connected, if the broker rejects it, or if no confirm
 * arrives within CONFIRM_TIMEOUT_MS — the caller decides what that means
 * (the outbox keeps the row and retries; a consumer's handler fails and the
 * incoming message is retried).
 */
export async function publishEnvelope(routingKey, envelope) {
  if (!isBrokerConnected()) {
    throw new Error("RabbitMQ is not connected");
  }
  const ch = channel;
  await withTimeout(
    new Promise((resolve, reject) => {
      ch.publish(
        EXCHANGE_NAME,
        routingKey,
        Buffer.from(JSON.stringify(envelope)),
        {
          persistent: true,
          contentType: "application/json",
          messageId: envelope.eventId,
          timestamp: Math.floor(Date.now() / 1000),
        },
        (err) => (err ? reject(new Error(`RabbitMQ rejected ${routingKey}`)) : resolve())
      );
    }),
    CONFIRM_TIMEOUT_MS,
    `no publisher confirm for ${routingKey} within ${CONFIRM_TIMEOUT_MS} ms`
  );
  recordEventPublished(routingKey); // Phase 10: sentinel_events_published_total
  return envelope;
}

/** Builds the envelope and publishes it with a confirm. Returns the envelope. */
export async function publishEvent(routingKey, payload, correlationId) {
  return publishEnvelope(routingKey, buildEnvelope(routingKey, payload, correlationId));
}

export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Declares a queue and binds it to the shared topic exchange for each given
 * routing key (or pattern, e.g. "#" for everything). `queueOptions` defaults
 * to a durable, shared queue (competing consumers); notification-service also
 * passes { exclusive: true, autoDelete: true, durable: false } for its
 * per-pod live-broadcast queue. Idempotent, like the database migrations.
 *
 * Dead-lettering is NOT a queue argument here: arguments can't be changed on
 * an existing queue, so the "sentinel-dead-letter" policy adds it instead.
 */
export async function assertQueueAndBind(queueName, routingKeys, queueOptions = { durable: true }) {
  if (!isBrokerConnected()) {
    throw new Error("RabbitMQ is not connected");
  }
  await channel.assertQueue(queueName, queueOptions);
  for (const key of routingKeys) {
    await channel.bindQueue(queueName, EXCHANGE_NAME, key);
  }
  console.log(`[${SERVICE_NAME}] queue '${queueName}' bound to [${routingKeys.join(", ")}]`);
}

/**
 * Runs handler(envelope), retrying after each delay in `delaysMs` while it
 * throws. Resolves { ok: true, attempts } or { ok: false, attempts, error }.
 * `sleep` is injectable for tests.
 */
export async function runWithRetries(handler, envelope, { delaysMs = RETRY_DELAYS_MS, sleep = defaultSleep } = {}) {
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      await handler(envelope);
      return { ok: true, attempts };
    } catch (error) {
      if (attempts > delaysMs.length) return { ok: false, attempts, error };
      await sleep(delaysMs[attempts - 1]);
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a delivered message into an envelope, or returns null when it isn't
 * one. JSON.parse also accepts "null", numbers and arrays; only an object is
 * a usable event envelope.
 */
export function parseEnvelope(content) {
  let envelope;
  try {
    envelope = JSON.parse(content.toString());
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  return envelope;
}

/**
 * Consumes a queue with manual acknowledgement.
 *  - handler succeeds (possibly after retries) → ack;
 *  - handler still fails after RETRY_DELAYS_MS → nack without requeue, so the
 *    queue's dead-letter policy moves it to q.dead-letters (Phase 14; before,
 *    it was dropped);
 *  - malformed (non-envelope) message → straight to the dead-letter queue,
 *    retrying can't fix it.
 * Messages on queues without the policy (the per-pod live queues) are
 * discarded on nack, as before.
 */
export async function consumeQueue(queueName, handler, { delaysMs = RETRY_DELAYS_MS } = {}) {
  if (!isBrokerConnected()) {
    throw new Error("RabbitMQ is not connected");
  }
  await channel.prefetch(10);
  // Phase 10: per-pod live queues (q.notifications.live.<pod-name>) are
  // reported under one label value, so pod restarts don't mint new series.
  const queueLabel = queueName.replace(/^(q\.notifications\.live)\..+$/, "$1");
  const ch = channel;
  // ack/nack on the channel this consumer was registered on; if that
  // channel has since closed, the broker redelivers the message anyway,
  // so a failed ack must not throw out of the callback.
  const settle = (msg, ok) => {
    try {
      if (ok) ch.ack(msg);
      else ch.nack(msg, false, false);
    } catch (err) {
      console.warn(`[${SERVICE_NAME}] could not ${ok ? "ack" : "nack"} message on '${queueName}':`, err.message);
    }
  };
  await ch.consume(queueName, async (msg) => {
    if (!msg) return;
    // Metrics are labelled by the routing key the broker delivered on, not
    // by the (untrusted) eventType inside the body — a forged eventType
    // can't mint new Prometheus series.
    const routingKey = msg.fields.routingKey;
    const envelope = parseEnvelope(msg.content);
    if (!envelope) {
      console.error(`[${SERVICE_NAME}] dead-lettering malformed message from '${queueName}' (routing key ${routingKey})`);
      settle(msg, false);
      recordEventConsumed({ queue: queueLabel, eventType: "unparseable", outcome: "invalid" });
      return;
    }
    // Phase 10: sentinel_events_consumed_total, sentinel_event_handler_seconds
    // (handler run time, all attempts) and sentinel_event_processing_seconds
    // (end-to-end: publisher's occurredAt → handled here). See metrics.js.
    const started = process.hrtime.bigint();
    const result = await runWithRetries(handler, envelope, { delaysMs });
    const handlerSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const id = String(envelope.eventId).slice(0, 64);
    if (!result.ok) {
      console.error(
        `[${SERVICE_NAME}] handler for '${queueName}' failed ${result.attempts} times on event ${routingKey} (${id}); dead-lettering:`,
        result.error?.message
      );
    } else if (result.attempts > 1) {
      console.warn(`[${SERVICE_NAME}] handler for '${queueName}' succeeded on attempt ${result.attempts} for event ${routingKey} (${id})`);
    }
    settle(msg, result.ok);
    // "error" = dead-lettered after every retry failed.
    recordEventConsumed({ queue: queueLabel, eventType: routingKey, occurredAt: envelope.occurredAt, outcome: result.ok ? "success" : "error", handlerSeconds });
  });
  console.log(`[${SERVICE_NAME}] consuming queue '${queueName}'`);
}

// --- Phase 14: dead-letter inspection (notification-service's admin API) ---

/**
 * Reads up to `limit` messages from q.dead-letters WITHOUT removing them:
 * each is fetched, recorded and nacked back with requeue. Uses its own
 * short-lived channel so it never disturbs the consumers' prefetch.
 */
export async function peekDeadLetters(limit = 50) {
  if (!isBrokerConnected()) throw new Error("RabbitMQ is not connected");
  const ch = await connection.createChannel();
  const held = [];
  try {
    const { messageCount } = await ch.checkQueue(DEAD_LETTER_QUEUE);
    const n = Math.min(limit, messageCount);
    for (let i = 0; i < n; i++) {
      const msg = await ch.get(DEAD_LETTER_QUEUE, { noAck: false });
      if (!msg) break;
      held.push(msg);
    }
    return { total: messageCount, messages: held.map(describeDeadLetter) };
  } finally {
    for (const msg of held) {
      try { ch.nack(msg, false, true); } catch { /* channel gone: the broker requeues unacked messages anyway */ }
    }
    await ch.close().catch(() => {});
  }
}

/**
 * Moves up to `limit` dead letters back onto the main exchange under their
 * original routing key, so the consumers get another go once the cause is
 * fixed. Each is acked from q.dead-letters only after its republish is
 * confirmed. Returns the number replayed.
 */
export async function replayDeadLetters(limit = 50) {
  if (!isBrokerConnected()) throw new Error("RabbitMQ is not connected");
  const ch = await connection.createChannel();
  let replayed = 0;
  try {
    for (let i = 0; i < limit; i++) {
      const msg = await ch.get(DEAD_LETTER_QUEUE, { noAck: false });
      if (!msg) break;
      const routingKey = originalRoutingKey(msg);
      const envelope = parseEnvelope(msg.content);
      try {
        if (!envelope) throw new Error("malformed message can't be replayed");
        await publishEnvelope(routingKey, envelope);
        ch.ack(msg);
        replayed++;
      } catch (err) {
        ch.nack(msg, false, true);
        throw err;
      }
    }
    return replayed;
  } finally {
    await ch.close().catch(() => {});
  }
}

function originalRoutingKey(msg) {
  const death = msg.properties.headers?.["x-death"]?.[0];
  return death?.["routing-keys"]?.[0] || msg.fields.routingKey;
}

/** What the admin API shows for one dead letter (never the raw headers). */
export function describeDeadLetter(msg) {
  const death = msg.properties.headers?.["x-death"]?.[0] || {};
  const envelope = parseEnvelope(msg.content);
  return {
    eventId: envelope?.eventId ?? msg.properties.messageId ?? null,
    eventType: envelope?.eventType ?? null,
    routingKey: death["routing-keys"]?.[0] ?? msg.fields.routingKey,
    sourceService: envelope?.sourceService ?? null,
    correlationId: envelope?.correlationId ?? null,
    fromQueue: death.queue ?? null,
    reason: death.reason ?? null,
    deadLetteredTimes: death.count ?? 1,
    firstDeadLetteredAt: death.time ? new Date(Number(death.time.value ?? death.time) * 1000).toISOString() : null,
    malformed: envelope === null,
  };
}
