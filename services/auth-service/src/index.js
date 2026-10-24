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
import { seedDefaultAdmin, seedSimulatorAccount } from "./db/seed.js";
import { createUserRepository } from "./repositories/userRepository.js";
import { createRefreshTokenRepository } from "./repositories/refreshTokenRepository.js";
import { createAuthRouter } from "./routes/authRoutes.js";
import { metricsMiddleware, metricsHandler, registerDependencyCheck } from "./metrics.js";
import { createAuditLogger } from "./security/audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8081;
const SERVICE_NAME = "auth-service";

const audit = createAuditLogger({ service: SERVICE_NAME });

const app = express();
// Requests arrive through the gateway, which (Phase 12) SETS
// X-Forwarded-For to the one client IP it determined — it no longer
// appends to whatever the client sent. So exactly one hop is trusted:
// req.ip (the key of the login rate limiter) is the gateway's verdict,
// and a client-supplied X-Forwarded-For can't spoof its way past it.
app.set("trust proxy", Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10) || 0);
app.disable("x-powered-by");
// Phase 10: time every request (registered before all routes, so auth
// rejections, 404s and proxied calls are all counted). Exposed at /metrics.
app.use(metricsMiddleware);
app.use(helmet());
// Phase 12: no cors() here. Browsers only talk to the gateway, which owns
// the CORS policy; a permissive "*" from this service would override it.
// Access log without query strings (no data from the URL in the logs).
morgan.token("path", (req) => String(req.originalUrl || req.url).split("?")[0]);
app.use(morgan(":method :path :status :response-time ms"));
app.use(express.json({ limit: "10kb" }));

// Malformed JSON bodies land here (express.json() throws a SyntaxError)
// — respond 400, not the default Express HTML error page.
app.use((err, req, res, next) => {
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

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: SERVICE_NAME, timestamp: new Date().toISOString() });
});

app.get("/health/ready", async (req, res) => {
  const db = await checkDbConnection();
  res.status(db.connected ? 200 : 503).json({
    status: db.connected ? "ready" : "not_ready",
    service: SERVICE_NAME,
    dependencies: { postgres: db.connected ? "connected" : "disconnected" },
    timestamp: new Date().toISOString(),
  });
});

// API docs — public, no auth required. Reachable both directly
// (localhost:8081/docs) and through the gateway
// (localhost:8080/api/v1/auth/docs).
const openApiDocument = YAML.parse(readFileSync(path.join(__dirname, "openapi.yaml"), "utf8"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
app.get("/openapi.json", (req, res) => res.json(openApiDocument));

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

  // Run migrations before accepting traffic — if migrations fail, the
  // service should not come up "healthy" and silently serve requests
  // against a schema it doesn't match.
  // Phase 9: serialised across replicas — see withStartupLock in db.js.
  await withStartupLock(async () => {
    await runMigrations(pool);
    await seedDefaultAdmin(pool);
    await seedSimulatorAccount(pool); // Phase 16
  });

  const userRepository = createUserRepository(pool);
  const refreshTokenRepository = createRefreshTokenRepository(pool);

  app.use("/", createAuthRouter({ userRepository, refreshTokenRepository, audit }));

  // Expired refresh tokens were never deleted; purge them hourly (and once
  // at startup). Every replica may run it — the DELETE is idempotent.
  const purge = () =>
    refreshTokenRepository
      .purgeExpired()
      .then((n) => n > 0 && console.log(`[${SERVICE_NAME}] purged ${n} expired refresh tokens`))
      .catch((err) => console.warn(`[${SERVICE_NAME}] refresh-token purge failed: ${err.message}`));
  purge();
  setInterval(purge, 60 * 60 * 1000).unref();

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.originalUrl}` } });
  });

  // Centralized error handler — anything an async route handler passed
  // to next(err) ends up here as a consistent JSON error envelope
  // instead of an Express default HTML stack trace.
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
    // Message and stack only: some driver errors carry the offending values in extra fields.
    console.error(`[${SERVICE_NAME}] unhandled error on ${req.method} ${req.path}: ${err.message}\n${err.stack}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  });

  const server = app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
    console.log(`[${SERVICE_NAME}] API docs at http://localhost:${PORT}/docs`);
  });
  registerGracefulShutdown(server);
}

start().catch((err) => {
  console.error(`[${SERVICE_NAME}] failed to start:`, err);
  process.exit(1);
});
