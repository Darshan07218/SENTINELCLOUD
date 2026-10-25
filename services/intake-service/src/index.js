import "dotenv/config";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { initPool, checkDbConnection, waitForDb, withStartupLock, closePool } from "./db.js";
import { runMigrations } from "./db/migrate.js";
import { createDetectionRepository } from "./repositories/detectionRepository.js";
import { createIntakeService, IntakeError } from "./services/intakeService.js";
import { createIntakeRouter } from "./routes/intakeRoutes.js";
import { createGatewayClient } from "./gatewayClient.js";
import { metricsMiddleware, metricsHandler, registerDependencyCheck, registry } from "./metrics.js";
import { SEVERITIES } from "./sources/geo.js";

/**
 * Phase 19 — intake-service: automatic disaster detection
 * (docs/PHASE-19-AUTO-DETECTION.md). Polls public feeds (USGS earthquakes,
 * Open-Meteo rain and wind) for the watched city, stores each event once,
 * auto-confirms the severe ones and keeps the rest for an operator, and
 * creates confirmed disasters through the API gateway.
 */
const PORT = Number(process.env.PORT || 8091);
const SERVICE_NAME = "intake-service";

function numberEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

// Default watch area: Pune, like the seed data.
const watch = {
  name: process.env.WATCH_NAME || "Pune",
  latitude: numberEnv("WATCH_LATITUDE", 18.5204),
  longitude: numberEnv("WATCH_LONGITUDE", 73.8567),
  radiusKm: numberEnv("WATCH_RADIUS_KM", 500),
  minMagnitude: numberEnv("WATCH_MIN_MAGNITUDE", 3.0),
};
const autoConfirmSetting = String(process.env.AUTO_CONFIRM_MIN_SEVERITY || "CRITICAL").toUpperCase();
const autoConfirmMinSeverity = [...SEVERITIES, "NONE"].includes(autoConfirmSetting) ? autoConfirmSetting : "CRITICAL";
// "usgs,open-meteo" (default), any subset, or "none" (e.g. offline demos).
const enabledSources = new Set(String(process.env.INTAKE_SOURCES || "usgs,open-meteo").toLowerCase().split(",").map((s) => s.trim()));

const app = express();
app.use(metricsMiddleware);
app.use(helmet());
app.disable("x-powered-by");
morgan.token("path", (req) => String(req.originalUrl || req.url).split("?")[0]);
app.use(morgan(":method :path :status :response-time ms"));

app.get("/metrics", metricsHandler);
registerDependencyCheck("postgres", async () => (await checkDbConnection()).connected);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: SERVICE_NAME, timestamp: new Date().toISOString() });
});

// Ready = can serve the API. The external feeds are NOT required: a feed
// being down is shown on the page (source status), not a reason to restart.
app.get("/health/ready", async (req, res) => {
  const db = await checkDbConnection();
  res.status(db.connected ? 200 : 503).json({
    status: db.connected ? "ready" : "not_ready",
    service: SERVICE_NAME,
    autoConfirmMinSeverity,
    dependencies: { postgres: db.connected ? "connected" : `disconnected (${db.error})` },
    timestamp: new Date().toISOString(),
  });
});

function registerGracefulShutdown(server, stop) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${SERVICE_NAME}] ${signal} received — shutting down`);
    stop();
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

  if (!process.env.INTAKE_EMAIL || !process.env.INTAKE_PASSWORD) {
    console.warn(`[${SERVICE_NAME}] INTAKE_EMAIL/INTAKE_PASSWORD not set: detections are recorded, but confirming them will fail`);
  }
  const gateway = createGatewayClient({
    baseUrl: process.env.GATEWAY_URL || "http://gateway:8080/api/v1",
    email: process.env.INTAKE_EMAIL,
    password: process.env.INTAKE_PASSWORD,
  });

  const newDetections = registry.counter("sentinel_intake_detections_new_total", "New detections, by source, type and severity.", ["source", "type", "severity"]);
  const repository = createDetectionRepository(pool);
  const intakeService = createIntakeService({
    repository,
    gateway,
    watch,
    autoConfirmMinSeverity,
    expireHours: numberEnv("DETECTION_EXPIRE_HOURS", 12),
    sources: {
      usgs: { enabled: enabledSources.has("usgs"), url: process.env.USGS_FEED_URL || undefined, intervalSeconds: numberEnv("USGS_POLL_SECONDS", 120) },
      openMeteo: { enabled: enabledSources.has("open-meteo"), url: process.env.OPEN_METEO_URL || undefined, intervalSeconds: numberEnv("OPEN_METEO_POLL_SECONDS", 1800) },
    },
    onDetection: (d) => newDetections.inc({ source: d.source, type: d.type, severity: d.severity }),
  });

  registry.gauge("sentinel_intake_detections", "Detections by source and status.", ["source", "status"], {
    collect: async () => (await repository.countByStatus()).map((r) => ({ labels: { source: r.source, status: r.status }, value: r.n })),
  });
  registry.gauge("sentinel_intake_source_up", "1 if the source's last poll succeeded.", ["source"], {
    collect: async () => (await repository.sources()).map((s) => ({ labels: { source: s.source }, value: s.lastError ? 0 : 1 })),
  });

  app.use(express.json({ limit: "8kb" }));
  app.use("/", createIntakeRouter({ intakeService }));
  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.originalUrl}` } });
  });
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON." } });
    if (err instanceof IntakeError || err.statusCode) return res.status(err.statusCode).json({ error: { code: err.code || "ERROR", message: err.message } });
    console.error(`[${SERVICE_NAME}] unhandled error on ${req.method} ${req.path}: ${err.message}\n${err.stack}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  });

  const server = app.listen(PORT, () => {
    console.log(
      `[${SERVICE_NAME}] listening on port ${PORT}; watching ${watch.name} (${watch.latitude}, ${watch.longitude}), ` +
        `sources: ${[...enabledSources].join(", ")}; auto-confirm at ${autoConfirmMinSeverity}`
    );
  });
  intakeService.start();
  registerGracefulShutdown(server, () => intakeService.stop());
}

start().catch((err) => {
  console.error(`[${SERVICE_NAME}] failed to start:`, err);
  process.exit(1);
});
