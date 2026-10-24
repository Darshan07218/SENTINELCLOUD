import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import YAML from "yaml";
import swaggerUi from "swagger-ui-express";

import { initPool, checkDbConnection, waitForDb, withStartupLock, closePool } from "./db.js";
import { runMigrations } from "./db/migrate.js";
import { seedSampleAmbulances, seedSampleEmergency } from "./db/seed.js";
import { connectBroker, isBrokerConnected, getBrokerError, publishEvent, assertQueueAndBind, consumeQueue } from "./broker.js";
import { createAmbulanceRepository } from "./repositories/ambulanceRepository.js";
import { createEmergencyRepository } from "./repositories/emergencyRepository.js";
import { withTransaction } from "./db/transaction.js";
import { createOutbox } from "./outbox.js";
import { createCommandProcessor } from "./commands.js";
import { createAmbulanceCommandHandlers, registerCommandConsumer } from "./consumers/commandConsumer.js";
import { createAmbulanceService } from "./services/ambulanceService.js";
import { createDispatchService } from "./services/dispatchService.js";
import { createEmergencyService } from "./services/emergencyService.js";
import { createAmbulanceRouter } from "./routes/ambulanceRoutes.js";
import { createEmergencyRouter } from "./routes/emergencyRoutes.js";
import { registerDisasterConsumer } from "./consumers/disasterConsumer.js";
import { createChaos } from "./chaos.js";
import { metricsMiddleware, metricsHandler, registerDependencyCheck } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8083;
const SERVICE_NAME = "ambulance-service";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";

const app = express();
// Phase 10: time every request (registered before all routes, so auth
// rejections, 404s and proxied calls are all counted). Exposed at /metrics.
app.use(metricsMiddleware);
// Phase 11: Resilience Demo fault injection (off unless CHAOS_ENABLED=true
// and a CHAOS_TOKEN is set). Registered AFTER the metrics middleware, so
// the 503s a deliberately-failed pod returns show up in Grafana's error
// rate, and BEFORE every route, so a "hung" pod fails /health and
// /health/ready too: that's what makes Kubernetes' probes notice.
const chaos = createChaos({ serviceName: SERVICE_NAME });
app.use(helmet());
app.use(chaos.middleware);
app.disable("x-powered-by");
// Phase 12: no cors() — browsers only talk to the gateway, which owns the
// CORS policy. Access log without query strings (no request data in logs).
morgan.token("path", (req) => String(req.originalUrl || req.url).split("?")[0]);
app.use(morgan(":method :path :status :response-time ms"));
app.use(express.json({ limit: "100kb" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON." } });
  }
  next(err);
});

// Phase 10: Prometheus scrape endpoint (cluster-internal: the frontend's
// nginx only proxies /api, /ws and /health, so it isn't publicly reachable).
app.get("/metrics", metricsHandler);
// sentinel_dependency_up{dependency=…} — evaluated at scrape time.
registerDependencyCheck("postgres", async () => (await checkDbConnection()).connected);
registerDependencyCheck("rabbitmq", () => isBrokerConnected());

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: SERVICE_NAME, timestamp: new Date().toISOString() });
});

app.get("/health/ready", async (req, res) => {
  const db = await checkDbConnection();
  const brokerOk = isBrokerConnected();
  res.status(db.connected ? 200 : 503).json({
    status: db.connected ? "ready" : "not_ready",
    service: SERVICE_NAME,
    dependencies: {
      postgres: db.connected ? "connected" : `disconnected (${db.error})`,
      rabbitmq: brokerOk ? "connected" : `disconnected (${getBrokerError() || "not yet connected"}, non-blocking)`,
    },
    timestamp: new Date().toISOString(),
  });
});

const openApiDocument = YAML.parse(readFileSync(path.join(__dirname, "openapi.yaml"), "utf8"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
app.get("/openapi.json", (req, res) => res.json(openApiDocument));

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

// ---------------------------------------------------------------------
// Phase 9: graceful shutdown for Kubernetes.
// On scale-down, rolling update or node drain, the kubelet sends
// SIGTERM, waits terminationGracePeriodSeconds (30s by default), then
// SIGKILLs. Node running as PID 1 in a container has NO default SIGTERM
// handler — without this, every pod termination would hang for the
// full 30s and then be killed mid-request. Here we stop accepting new
// connections, let in-flight requests finish, close the DB pool, and
// exit. (The Deployment's preStop sleep gives kube-proxy time to remove
// this pod from the Service's endpoints before SIGTERM arrives, so no
// new requests are routed here while it drains.)
// ---------------------------------------------------------------------
function registerGracefulShutdown(server) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${SERVICE_NAME}] ${signal} received — draining in-flight requests and shutting down`);
    setTimeout(() => process.exit(1), 10000).unref(); // hard stop if draining stalls
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
  // Phase 9: serialised across replicas — see withStartupLock in db.js.
  await withStartupLock(async () => {
    await runMigrations(pool);
    await seedSampleAmbulances(pool);
    await seedSampleEmergency(pool);
  });

  const ambulanceRepository = createAmbulanceRepository(pool);
  const emergencyRepository = createEmergencyRepository(pool);

  const ambulanceService = createAmbulanceService({ ambulanceRepository });
  // Dispatch, completion and cancellation write to both tables; run them
  // in one transaction with repositories bound to that connection.
  // Phase 14: `client` lets the dispatch service write its events to the
  // outbox in the same transaction; the relay delivers them.
  const transaction = (fn) =>
    withTransaction(pool, (client) =>
      fn({ ambulanceRepository: createAmbulanceRepository(client), emergencyRepository: createEmergencyRepository(client), client })
    );
  const outbox = createOutbox({ pool });
  const dispatchService = createDispatchService({ ambulanceRepository, emergencyRepository, publishEvent, transaction, outbox });
  const emergencyService = createEmergencyService({ emergencyRepository, dispatchService });

  app.use("/emergencies", createEmergencyRouter({ emergencyService }));
  app.use("/", createAmbulanceRouter({ ambulanceService, dispatchService }));

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.originalUrl}` } });
  });

  app.use((err, req, res, next) => {
    // Postgres constraint errors that a concurrent request can trigger
    // even after the service's own pre-checks passed (two registrations of
    // the same unique value, a capacity update racing a total change).
    // They are the caller's conflict, not a server fault.
    const PG_CONFLICTS = { "23505": "ALREADY_EXISTS", "23514": "CONSTRAINT_VIOLATION", "23503": "REFERENCE_VIOLATION" };
    if (PG_CONFLICTS[err.code]) {
      return res.status(409).json({
        error: { code: PG_CONFLICTS[err.code], message: "The request conflicts with the current state of the data. Reload and try again." },
      });
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: { code: err.code || "ERROR", message: err.message } });
    }
    console.error(`[${SERVICE_NAME}] unhandled error on ${req.method} ${req.path}: ${err.message}\n${err.stack}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  });

  const server = app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
    console.log(`[${SERVICE_NAME}] API docs at http://localhost:${PORT}/docs`);
  });
  registerGracefulShutdown(server);
  // Sends anything left unsent before this pod started, then sweeps every 2 s.
  outbox.start();

  // Phase 15: response-service's commands (dispatch / stand-down), executed
  // once each (commands.js) through the same dispatch code operators use.
  const processCommand = createCommandProcessor({ pool, outbox });
  const startDisasterConsumer = registerDisasterConsumer({ consumeQueue, assertQueueAndBind, ambulanceService, publishEvent });
  const startCommandConsumer = registerCommandConsumer({
    consumeQueue,
    assertQueueAndBind,
    processCommand,
    handlers: createAmbulanceCommandHandlers({ emergencyRepository, dispatchService }),
  });
  await connectBrokerWithRetry(async () => {
    await startDisasterConsumer();
    await startCommandConsumer();
  });
}

start().catch((err) => {
  console.error(`[${SERVICE_NAME}] failed to start:`, err);
  process.exit(1);
});
