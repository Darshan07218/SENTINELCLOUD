import "dotenv/config";
import express from "express";
import os from "node:os";
import helmet from "helmet";
import morgan from "morgan";
import { WebSocketServer } from "ws";
import { initRedis, checkRedisConnection, recordRecentEvent, getRecentEvents } from "./redis.js";
import { connectBroker, isBrokerConnected, getBrokerError, assertQueueAndBind, consumeQueue, peekDeadLetters, replayDeadLetters } from "./broker.js";
import { createRecentIds } from "./recentIds.js";
import { QUEUES } from "./events/eventTypes.js";
import { metricsMiddleware, metricsHandler, registerDependencyCheck, registry } from "./metrics.js";
import { requireSecret } from "./security/secrets.js";
import { verifyAccessToken, bearerToken } from "./security/jwt.js";

const PORT = process.env.PORT || 8087;
const SERVICE_NAME = "notification-service";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
// Phase 12: this service now verifies access tokens itself too (REST and
// WebSocket), so it is safe even if something reaches it without the gateway.
const ACCESS_SECRET = requireSecret("JWT_ACCESS_SECRET");
const WS_APP_PROTOCOL = "sentinel-live";
const WS_MAX_CLIENTS = Number(process.env.WS_MAX_CLIENTS || 500);

function authenticate(token) {
  try {
    return verifyAccessToken(token, ACCESS_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = authenticate(bearerToken(req.headers.authorization));
  if (!user) return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Valid access token required." } });
  req.user = { id: user.sub, role: user.role };
  return next();
}

initRedis();

const app = express();
// Phase 10: time every request (registered before all routes, so auth
// rejections, 404s and proxied calls are all counted). Exposed at /metrics.
app.use(metricsMiddleware);
app.use(helmet());
app.disable("x-powered-by");
// Phase 12: no cors() — browsers only talk to the gateway, which owns the
// CORS policy. Access log without query strings (no request data in logs).
morgan.token("path", (req) => String(req.originalUrl || req.url).split("?")[0]);
app.use(morgan(":method :path :status :response-time ms"));

// Phase 10: Prometheus scrape endpoint (cluster-internal: the frontend's
// nginx only proxies /api, /ws and /health, so it isn't publicly reachable).
app.get("/metrics", metricsHandler);
// sentinel_dependency_up{dependency=…} — evaluated at scrape time.
registerDependencyCheck("redis", async () => (await checkRedisConnection()).connected);
registerDependencyCheck("rabbitmq", () => isBrokerConnected());

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: SERVICE_NAME, timestamp: new Date().toISOString() });
});

app.get("/health/ready", async (req, res) => {
  const redisStatus = await checkRedisConnection();
  const brokerOk = isBrokerConnected();
  const allOk = redisStatus.connected && brokerOk;
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ready" : "not_ready",
    service: SERVICE_NAME,
    dependencies: {
      redis: redisStatus.connected ? "connected" : "disconnected",
      rabbitmq: brokerOk ? "connected" : `disconnected (${getBrokerError() || "not yet connected"})`,
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Feature: live emergency dashboard needs SOME history the instant it
 * loads, before its WebSocket has had a chance to receive any live
 * events — this is the REST fallback/bootstrap for that initial
 * render. Live updates after that come exclusively over /ws/live; the
 * dashboard does not poll this endpoint.
 */
app.get("/events/recent", requireAuth, async (req, res) => {
  const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 50, 200));
  try {
    const events = await getRecentEvents(limit);
    res.status(200).json({ events, count: events.length });
  } catch (err) {
    // Phase 12: an async handler that throws would be an unhandled
    // rejection — on Node 20+ that crashes the process.
    console.error(`[${SERVICE_NAME}] failed to read recent events: ${err.message}`);
    res.status(503).json({ error: { code: "UNAVAILABLE", message: "Recent events are temporarily unavailable." } });
  }
});

// ---------------------------------------------------------------------
// Phase 14: dead-letter queue (docs/PHASE-14-RELIABLE-EVENTS.md §2.5).
// Messages whose handler failed after every retry, or that weren't valid
// events, end up in q.dead-letters instead of being dropped. SYSTEM_ADMIN
// only — the gateway's role table enforces it too.
// ---------------------------------------------------------------------
function requireSystemAdmin(req, res, next) {
  if (req.user?.role !== "SYSTEM_ADMIN") {
    return res.status(403).json({ error: { code: "FORBIDDEN", message: "Only a SYSTEM_ADMIN can manage dead letters." } });
  }
  return next();
}

function deadLetterLimit(value) {
  return Math.max(1, Math.min(Number.parseInt(value, 10) || 50, 200));
}

/** Lists dead letters (where each came from and why). Nothing is removed. */
app.get("/dead-letters", requireAuth, requireSystemAdmin, async (req, res) => {
  try {
    const { total, messages } = await peekDeadLetters(deadLetterLimit(req.query.limit));
    res.status(200).json({ total, shown: messages.length, deadLetters: messages });
  } catch (err) {
    console.error(`[${SERVICE_NAME}] failed to read dead letters: ${err.message}`);
    res.status(503).json({ error: { code: "UNAVAILABLE", message: "The message broker is unavailable. Try again shortly." } });
  }
});

/**
 * Sends dead letters back under their original routing key, once the cause
 * is fixed. A message that fails again simply returns to the dead-letter
 * queue, so replaying is always safe to repeat.
 */
app.post("/dead-letters/replay", requireAuth, requireSystemAdmin, express.json({ limit: "1kb" }), async (req, res) => {
  try {
    const replayed = await replayDeadLetters(deadLetterLimit(req.body?.limit));
    console.log(`[${SERVICE_NAME}] user ${req.user.id} replayed ${replayed} dead letter(s)`);
    res.status(200).json({ replayed });
  } catch (err) {
    console.error(`[${SERVICE_NAME}] dead-letter replay failed: ${err.message}`);
    res.status(503).json({ error: { code: "UNAVAILABLE", message: `Replay stopped: ${err.message}` } });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
});

const server = app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});

// ---------------------------------------------------------------------
// WebSocket server, mounted at /ws/live (the gateway proxies WS
// upgrades here — see services/gateway/src/index.js). Phase 7: every
// event published anywhere on the bus (disaster.detected,
// disaster.updated, and all four reaction events) is fanned out to
// every connected client verbatim, wrapped in a small { type: "event",
// event: <envelope> } frame the frontend distinguishes from the
// connection-management frames (welcome/heartbeat) below.
// ---------------------------------------------------------------------
// Phase 12: the handshake must carry a valid access token as the
// sub-protocol "bearer.<jwt>" (the gateway checks it first; this is the
// second check). Messages from clients are capped at 4 KB — the feed is
// one-way, clients have nothing to send — and connections are capped.
const wss = new WebSocketServer({
  server,
  path: "/ws/live",
  maxPayload: 4 * 1024,
  verifyClient: ({ req }, done) => {
    if (wss.clients.size >= WS_MAX_CLIENTS) return done(false, 503, "Too many live-feed connections");
    const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((p) => p.trim());
    const bearer = protocols.find((p) => p.startsWith("bearer."));
    if (!bearer || !authenticate(bearer.slice("bearer.".length))) return done(false, 401, "Unauthorized");
    return done(true);
  },
  // Answer with the application protocol, never echo the token back.
  handleProtocols: (protocols) => (protocols.has(WS_APP_PROTOCOL) ? WS_APP_PROTOCOL : false),
});

// Phase 10: live-feed connections on THIS replica (sum across pods for the total).
registry.gauge("sentinel_websocket_clients", "WebSocket clients connected to /ws/live on this instance.", [], {
  collect: async () => [{ value: wss.clients.size }],
});

// A client that stops reading (backgrounded tab on a bad network) makes
// ws buffer every frame for it in this process's memory. Past this many
// unsent bytes it is disconnected; the frontend reconnects and re-reads
// /events/recent.
const WS_MAX_BUFFERED_BYTES = 1024 * 1024;
// Phase 14: event IDs this pod already pushed (see registerFanOutConsumers).
const liveSeen = createRecentIds(1000);

function broadcast(frame) {
  const raw = JSON.stringify(frame);
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;
    if (client.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
      client.terminate();
      continue;
    }
    client.send(raw);
  }
}

// Protocol-level ping/pong: a connection whose peer vanished without a
// FIN (laptop lid closed, NAT entry expired) never emits 'close' on its
// own. Every 30 s, a socket that didn't answer the previous ping is
// terminated, so wss.clients and the gauge above stay accurate.
const deadSocketSweep = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      client.terminate();
    }
  }
}, 30000);
deadSocketSweep.unref();

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  console.log(`[${SERVICE_NAME}] client connected, total clients: ${wss.clients.size}`);
  ws.send(JSON.stringify({ type: "welcome", message: "connected to SentinelCloud live feed", timestamp: new Date().toISOString() }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "heartbeat", timestamp: new Date().toISOString() }));
    }
  }, 15000);

  // The feed is one-way. Client messages are ignored and never logged
  // (logging them let anyone write arbitrary text into the service logs).
  ws.on("message", () => {});
  ws.on("error", () => ws.terminate());

  ws.on("close", () => {
    clearInterval(heartbeat);
    console.log(`[${SERVICE_NAME}] client disconnected, total clients: ${wss.clients.size}`);
  });
});

// Phase 9 (Kubernetes): retry FOREVER with capped backoff, instead of
// 10 attempts × 3s. On a fresh cluster RabbitMQ (image pull + Erlang
// boot) routinely takes longer than 30s, and the old loop would then
// give up permanently — leaving this pod running without its
// consumers for its whole life. Also reconnects automatically if the
// broker restarts later (pod rescheduled, node drained…): the
// `onClose` hook re-runs this loop, and `onConnected` re-declares
// queues and re-attaches consumers on the fresh channel.
async function connectBrokerWithRetry(onConnected) {
  for (let attempt = 1; ; attempt++) {
    try {
      await connectBroker(RABBITMQ_URL, { onClose: () => handleBrokerLost(onConnected) });
      break;
    } catch (err) {
      const delayMs = Math.min(2000 * attempt, 15000);
      console.log(`[${SERVICE_NAME}] RabbitMQ not ready (attempt ${attempt}: ${err.message}), retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (onConnected) {
    try {
      await onConnected();
    } catch (err) {
      // Connected but couldn't declare/consume — a half-wired pod is worse
      // than a restarted one. Crash so the kubelet (or Compose's restart
      // policy) brings up a clean process.
      console.error(`[${SERVICE_NAME}] failed to register RabbitMQ consumers, exiting for a clean restart:`, err.message);
      process.exit(1);
    }
  }
  return true;
}

function handleBrokerLost(onConnected) {
  console.warn(`[${SERVICE_NAME}] RabbitMQ connection lost — reconnecting`);
  setTimeout(() => connectBrokerWithRetry(onConnected), 1000);
}

async function registerFanOutConsumers() {
  // -------------------------------------------------------------------
  // Two consumers, deliberately — this is what makes notification-
  // service safe to run with more than one replica (Phase 9).
  //
  // 1. HISTORY (shared, durable queue, competing consumers):
  //    "#" — the topic-exchange wildcard meaning "every routing key" —
  //    the ONE durable queue in the system that binds to everything
  //    (docs/ARCHITECTURE.md section 4.1). With N replicas RabbitMQ
  //    round-robins its messages, so each event is written to the
  //    Redis recent-events list EXACTLY ONCE, by whichever replica got
  //    it. (If every replica wrote every event, history would contain
  //    N duplicates of each.)
  //
  // 2. LIVE BROADCAST (one exclusive, auto-delete queue PER POD):
  //    WebSocket clients are pinned to whichever replica the Service
  //    happened to route their connection to. If broadcasting also
  //    rode the shared queue above, a client on replica A would never
  //    see the ~(N-1)/N of events RabbitMQ delivered to replicas B and
  //    C. Giving every pod its own queue bound to "#" means every
  //    replica receives every event and pushes it to its own clients.
  //    exclusive + autoDelete: RabbitMQ deletes the queue when this
  //    pod's connection closes, so scaled-down/restarted pods leave no
  //    orphaned queues behind. os.hostname() is the pod name in
  //    Kubernetes (and the container ID under Compose) — unique per
  //    replica.
  // -------------------------------------------------------------------
  await assertQueueAndBind(QUEUES.NOTIFICATIONS_ALL_EVENTS, ["#"]);
  await consumeQueue(QUEUES.NOTIFICATIONS_ALL_EVENTS, async (envelope) => {
    await recordRecentEvent(envelope);
  });

  const liveQueue = `${QUEUES.NOTIFICATIONS_LIVE_PREFIX}${os.hostname()}`;
  await assertQueueAndBind(liveQueue, ["#"], { durable: false, exclusive: true, autoDelete: true });
  await consumeQueue(liveQueue, async (envelope) => {
    // Phase 14: a redelivered event (outbox resend) isn't pushed twice.
    if (liveSeen.firstTime(envelope.eventId)) broadcast({ type: "event", event: envelope });
  });
  console.log(`[${SERVICE_NAME}] history → shared '${QUEUES.NOTIFICATIONS_ALL_EVENTS}', live → per-pod '${liveQueue}'`);
}

// Phase 9: graceful shutdown on SIGTERM (Node as PID 1 ignores it by
// default). Open WebSockets would keep server.close() waiting forever,
// so they're closed with code 1001 "going away" — the frontend's
// reconnect logic then lands them on a surviving replica.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${SERVICE_NAME}] ${signal} received — closing ${wss.clients.size} WebSocket client(s) and shutting down`);
  for (const client of wss.clients) client.close(1001, "server shutting down");
  setTimeout(() => process.exit(0), 5000).unref();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

connectBrokerWithRetry(registerFanOutConsumers);
