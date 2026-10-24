import amqplib from "amqplib";

let connection = null;
let channel = null;
let lastError = null;

/**
 * Connects to RabbitMQ once at startup and keeps a single shared channel.
 * Phase 1 scope: connectivity only — no exchanges/queues declared yet,
 * that happens in Phase 2 when the Disaster Service starts publishing
 * DISASTER_DETECTED events.
 */
// Phase 9: `onClose` lets index.js reconnect (and re-register its
// consumers) after RabbitMQ restarts — see connectBrokerWithRetry there.
export async function connectBroker(url, { onClose } = {}) {
  try {
    connection = await amqplib.connect(url);
    channel = await connection.createChannel();
    lastError = null;

    connection.on("close", () => {
      console.warn("[gateway] RabbitMQ connection closed");
      connection = null;
      channel = null;
      if (onClose) onClose();
    });
    connection.on("error", (err) => {
      console.error("[gateway] RabbitMQ connection error:", err.message);
      lastError = err.message;
    });

    console.log("[gateway] connected to RabbitMQ");
    return channel;
  } catch (err) {
    lastError = err.message;
    console.error("[gateway] failed to connect to RabbitMQ:", err.message);
    throw err;
  }
}

export function isBrokerConnected() {
  return Boolean(connection && channel);
}

export function getBrokerError() {
  return lastError;
}
