import Redis from "ioredis";
import { requireSecret } from "./security/secrets.js";

let client = null;

const RECENT_EVENTS_KEY = "sentinelcloud:events:recent";
const RECENT_EVENTS_MAX = 200;
// Phase 14: one short-lived marker per stored eventId (see recordRecentEvent).
const SEEN_KEY_PREFIX = "sentinelcloud:events:seen:";
const SEEN_TTL_SECONDS = 24 * 60 * 60;

export function initRedis() {
  client = new Redis({
    host: process.env.REDIS_HOST || "redis",
    port: Number(process.env.REDIS_PORT || 6379),
    // Phase 12: Redis requires a password (requirepass) in Compose and Kubernetes.
    password: requireSecret("REDIS_PASSWORD", { minLength: 16 }),
    retryStrategy: (times) => Math.min(times * 500, 5000),
    lazyConnect: false,
    // Fail fast while Redis is down instead of queueing commands forever:
    // otherwise /health/ready's PING (and every history write) hangs until
    // the probe itself times out, rather than answering 503 promptly.
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
  });

  client.on("connect", () => console.log("[notification-service] connected to Redis"));
  client.on("error", (err) => console.error("[notification-service] Redis error:", err.message));

  return client;
}

export function getRedis() {
  if (!client) throw new Error("Redis client not initialized — call initRedis() first");
  return client;
}

export async function checkRedisConnection() {
  try {
    const pong = await getRedis().ping();
    return { connected: pong === "PONG" };
  } catch (err) {
    console.warn("[notification-service] Redis check failed:", err.message);
    return { connected: false, error: "connection failed" };
  }
}

/**
 * Pushes an event envelope onto a capped recent-events list, so a
 * dashboard client that connects AFTER an event fired can still fetch
 * the last ~200 events via GET /events/recent instead of only seeing
 * events that happen to occur while its WebSocket is open. LPUSH +
 * LTRIM keeps the list bounded without a separate cleanup job — same
 * "cap it at insert time" approach as a circular buffer.
 */
export async function recordRecentEvent(envelope) {
  const redis = getRedis();
  // Phase 14: delivery is at-least-once (outbox resends, consumer retries),
  // so the same event can arrive twice. SET NX on its eventId lets only the
  // first copy in; the marker lives a day, far longer than any redelivery.
  const seenKey = envelope.eventId ? `${SEEN_KEY_PREFIX}${String(envelope.eventId).slice(0, 64)}` : null;
  if (seenKey) {
    const fresh = await redis.set(seenKey, "1", "EX", SEEN_TTL_SECONDS, "NX");
    if (fresh !== "OK") return false;
  }
  try {
    // MULTI/EXEC: push and trim atomically, so a failure between the two
    // can't leave the list growing past its cap.
    await redis
      .multi()
      .lpush(RECENT_EVENTS_KEY, JSON.stringify(envelope))
      .ltrim(RECENT_EVENTS_KEY, 0, RECENT_EVENTS_MAX - 1)
      .exec();
  } catch (err) {
    // Not stored: forget the marker so the retry isn't mistaken for a duplicate.
    if (seenKey) await redis.del(seenKey).catch(() => {});
    throw err;
  }
  return true;
}

/** Most recent first (matches LPUSH insertion order), optionally capped further than the stored max. */
export async function getRecentEvents(limit = 50) {
  const redis = getRedis();
  const raw = await redis.lrange(RECENT_EVENTS_KEY, 0, Math.min(limit, RECENT_EVENTS_MAX) - 1);
  // One corrupt entry must not make the whole history endpoint fail.
  return raw.flatMap((item) => {
    try {
      return [JSON.parse(item)];
    } catch {
      return [];
    }
  });
}
