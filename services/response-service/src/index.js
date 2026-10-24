import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { initPool, checkDbConnection, waitForDb, withStartupLock, closePool } from "./db.js";
import { runMigrations } from "./db/migrate.js";
import { withTransaction } from "./db/transaction.js";
import { createOutbox } from "./outbox.js";
import { connectBroker, isBrokerConnected, getBrokerError, assertQueueAndBind, consumeQueue } from "./broker.js";
import { createResponseRepository } from "./repositories/responseRepository.js";
import { createResponseService, REACTION_KEYS } from "./services/responseService.js";
import { createResponseRouter } from "./routes/responseRoutes.js";
import { metricsMiddleware, metricsHandler, registerDependencyCheck, registry } from "./metrics.js";

/**
 * Phase 15 — response-service: the automated response engine
 * (docs/PHASE-15-RESPONSE-ENGINE.md). Listens to disasters, the four
 * reactions and command replies on one queue; proposes plans from the
 * playbook; executes approved plans by sending commands through its outbox.
 */
const PORT = process.env.PORT || 8089;
const SERVICE_NAME = "response-service";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
// Default is approval mode: a person decides. "true" executes plans at once.
const AUTO_APPROVE = process.env.RESPONSE_AUTO_APPROVE === "true";
const SWEEP_INTERVAL_MS = 5000;

const QUEUE = "q.response.events";
const DISASTER_KEYS = ["disaster.detected", "disaster.updated", "disaster.resolved"];
const REPLY_KEYS = ["command.succeeded", "command.failed"];

const app = express();
app.use(metricsMiddleware);
app.use(helmet());
app.disable("x-powered-by");
// No cors(): browsers only talk to the gateway. Access log without query strings.
morgan.token("path", (req) => String(req.originalUrl || req.url).split("?")[0]);
app.use(morgan(":method :path :status :response-time ms"));

app.get("/metrics", metricsHandler);
registerDependencyCheck("postgres", async () => (await checkDbConnection()).connected);
registerDependencyCheck("rabbitmq", () => isBrokerConnected());

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: SERVICE_NAME, timestamp: new Date().toISOString() });
});

app.get("/health/ready", async (req, res) => {
  const db = await checkDbConnection();
  const brokerOk = isBrokerConnected();
  // Without RabbitMQ this service hears nothing and can't execute plans.
  const allOk = db.connected && brokerOk;
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ready" : "not_ready",
    service: SERVICE_NAME,
    mode: AUTO_APPROVE ? "AUTO" : "APPROVAL",
    dependencies: {
      postgres: db.connected ? "connected" : `disconnected (${db.error})`,
      rabbitmq: brokerOk ? "connected" : `disconnected (${getBrokerError() || "not yet connected"})`,
    },
    timestamp: new Date().toISOString(),
  });
});

// Retry forever with capped backoff, and reconnect (re-declaring the queue
// and consumer) whenever RabbitMQ restarts — same as the other services.
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
  try {
    await onConnected();
  } catch (err) {
    console.error(`[${SERVICE_NAME}] failed to register RabbitMQ consumers, exiting for a clean restart:`, err.message);
    process.exit(1);
  }
}

function handleBrokerLost(onConnected) {
  console.warn(`[${SERVICE_NAME}] RabbitMQ connection lost — reconnecting`);
  setTimeout(() => connectBrokerWithRetry(onConnected), 1000);
}

// Graceful shutdown on SIGTERM (Node as PID 1 has no default handler).
function registerGracefulShutdown(server, stoppers) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${SERVICE_NAME}] ${signal} received — draining in-flight requests and shutting down`);
    for (const stop of stoppers) stop();
    setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      await closePool().catch(() => {});
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function start() {
  const pool = initPool();
  await waitForDb();
  await withStartupLock(() => runMigrations(pool));

  const repository = createResponseRepository(pool);
  const outbox = createOutbox({ pool });
  const transaction = (fn) => withTransaction(pool, (client) => fn({ repo: createResponseRepository(client), client }));
  const responseService = createResponseService({ transaction, repository, outbox, autoApprove: AUTO_APPROVE });

  // Plans by status, read at scrape time (e.g. how many wait for a decision).
  registry.gauge("sentinel_response_plans", "Response plans by status.", ["status"], {
    collect: async () => (await repository.countPlansByStatus()).map((r) => ({ labels: { status: r.status }, value: r.n })),
  });

  app.use(express.json({ limit: "16kb" }));
  app.use("/", createResponseRouter({ responseService, autoApprove: AUTO_APPROVE }));
  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.originalUrl}` } });
  });
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON." } });
    if (err.statusCode) return res.status(err.statusCode).json({ error: { code: err.code || "ERROR", message: err.message } });
    console.error(`[${SERVICE_NAME}] unhandled error on ${req.method} ${req.path}: ${err.message}\n${err.stack}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  });

  const server = app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT} (${AUTO_APPROVE ? "AUTO" : "APPROVAL"} mode)`);
  });
  outbox.start();
  const sweeper = setInterval(() => responseService.sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref();
  registerGracefulShutdown(server, [() => outbox.stop(), () => clearInterval(sweeper)]);

  const routes = {};
  for (const key of DISASTER_KEYS) routes[key] = responseService.handleDisasterEvent;
  for (const key of Object.keys(REACTION_KEYS)) routes[key] = responseService.handleReaction;
  for (const key of REPLY_KEYS) routes[key] = responseService.handleCommandReply;

  await connectBrokerWithRetry(async () => {
    await assertQueueAndBind(QUEUE, Object.keys(routes));
    await consumeQueue(QUEUE, async (envelope) => {
      const handle = routes[envelope.eventType];
      if (handle) await handle(envelope);
    });
    console.log(`[${SERVICE_NAME}] consuming '${QUEUE}' — ready to plan responses`);
  });
}

start().catch((err) => {
  console.error(`[${SERVICE_NAME}] failed to start:`, err);
  process.exit(1);
});
