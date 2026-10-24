/**
 * resilience-service (Phase 11): the Resilience Demo's control plane.
 *
 * Runs controlled SOFTWARE failure drills against SentinelCloud's own
 * services and watches, through the Kubernetes API, how the platform
 * detects and recovers. Zero runtime dependencies (Node core only).
 *
 * API (through the gateway: /api/v1/resilience/…; JWT required, and
 * writes need SYSTEM_ADMIN at the gateway AND here):
 *   GET  /scenarios            catalogue + whether drills can run here
 *   GET  /overview             live normal-state view of the targets
 *   GET  /runs/current         the current (or most recent) drill, polled by the page
 *   POST /runs                 { "scenarioId": "hospital-failure" } → start a drill
 *   POST /runs/current/abort   stop the drill (cleanup still runs)
 *   GET  /health, /health/ready, /metrics
 */
import http from "node:http";
import { httpRequest } from "./http.js";
import { createK8sClient, inClusterAvailable, summarizeHpa } from "./k8s.js";
import { createRabbitAdmin } from "./rabbit.js";
import { verifyAccessToken, TokenError } from "./security/jwt.js";
import { requireSecret, requireEnv } from "./security/secrets.js";
import { createAuditLogger } from "./security/audit.js";
import { ResilienceEngine, ConflictError, UnavailableError, STAGES } from "./runner.js";
import { buildScenarios, TARGETS, targetPods, targetEndpoints } from "./scenarios.js";
import { registry, metricsMiddleware } from "./metrics.js";

const SERVICE_NAME = "resilience-service";
const PORT = Number(process.env.PORT || 8088);

export const DEFAULT_CONFIG = Object.freeze({
  replicas: 2,                 // replicas during pod-failure drills (one fails, one keeps serving)
  normalMs: 8000,              // how long to show the normal state before injecting the fault
  holdMs: 8000,                // how long to show the restored state
  minStageDisplayMs: 5000,     // each stage stays on screen at least this long (presentation only)
  pollMs: 1000,
  sampleMs: 1000,
  probeIntervalMs: 250,        // 4 requests/s through the Service
  prepareTimeoutMs: 240000,
  detectTimeoutMs: 150000,
  recoverTimeoutMs: 300000,
  restoreTimeoutMs: 300000,
  load: { concurrency: 8, workMs: 40 },
  broker: { produceEveryMs: 200, consumePerSec: 10, consumeEveryMs: 1000, backlogMs: 6000 },
});

export function createApp({ engine, jwtSecret, k8s, audit = () => {} }) {
  const runsTotal = registry.counter("sentinel_resilience_runs_total", "Resilience drills finished, by scenario and outcome.", ["scenario", "outcome"]);
  registry.gauge("sentinel_resilience_run_active", "1 while a resilience drill is running.", [], {
    collect: async () => [{ value: engine.isRunning() ? 1 : 0 }],
  });
  registry.gauge(
    "sentinel_resilience_stage_index",
    "Current drill stage: 0 NORMAL, 1 FAILURE, 2 DETECTION, 3 RECOVERY, 4 RESTORED (absent when no drill is running).",
    ["scenario"],
    { collect: async () => (engine.isRunning() && engine.run.stage ? [{ labels: { scenario: engine.run.scenarioId }, value: STAGES.indexOf(engine.run.stage) }] : []) }
  );
  engine.onRunFinished = (run) => runsTotal.inc({ scenario: run.scenarioId, outcome: run.status });

  function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    // Phase 12: the same baseline headers helmet gives the Express services.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.end(JSON.stringify(body));
  }
  const error = (res, status, code, message) => send(res, status, { error: { code, message } });

  function authenticate(req) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw new TokenError("missing bearer token");
    return verifyAccessToken(token, jwtSecret);
  }

  async function readJson(req) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10_000) throw new Error("body too large");
    }
    return raw ? JSON.parse(raw) : {};
  }

  const KNOWN_ROUTES = new Set(["/health", "/health/ready", "/scenarios", "/overview", "/runs", "/runs/current", "/runs/current/abort"]);

  async function overview() {
    const avail = engine.availability();
    if (!k8s) return { ...avail, services: [] };
    const services = await Promise.all(
      Object.keys(TARGETS).map(async (service) => {
        // One service's lookup failing (e.g. a transient API-server error)
        // must not blank the whole overview: report it as unknown instead.
        const [pods, endpoints, hpa] = await Promise.all([
          targetPods({ k8s }, service).catch(() => null),
          targetEndpoints({ k8s }, service).catch(() => null),
          k8s.getHpa(service).then(summarizeHpa).catch(() => null),
        ]);
        return { service, pods: pods || [], readyEndpoints: endpoints ? endpoints.filter((e) => e.ready).length : null, hpa };
      })
    );
    let broker = null;
    try {
      const pods = await targetPods({ k8s }, "rabbitmq");
      broker = pods[0] || null;
    } catch {
      broker = null;
    }
    return { ...avail, services, broker };
  }

  return async function handler(req, res) {
    const url = new URL(req.url, "http://local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    Object.assign(req, { path, baseUrl: "", route: undefined });

    if (path === "/metrics") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return res.end(await registry.render());
    }
    // Route templates for the request histogram (resilience routes have no
    // ids). Unknown paths share one label value: labelling by the raw path
    // let any caller mint unlimited Prometheus series (/x1, /x2, …).
    req.route = { path: KNOWN_ROUTES.has(path) ? path : "unmatched" };
    metricsMiddleware(req, res, () => {});

    try {
      if (req.method === "GET" && path === "/health") return send(res, 200, { status: "ok", service: SERVICE_NAME, timestamp: new Date().toISOString() });
      if (req.method === "GET" && path === "/health/ready") {
        return send(res, 200, { status: "ready", service: SERVICE_NAME, dependencies: { kubernetes: k8s ? "in-cluster" : "not available (not running in Kubernetes)" }, timestamp: new Date().toISOString() });
      }

      let user;
      try {
        user = authenticate(req);
      } catch (err) {
        // Phase 12: don't tell the caller WHY (bad signature, wrong alg…).
        return error(res, 401, "UNAUTHORIZED", "Valid access token required.");
      }

      if (req.method === "GET" && path === "/scenarios") return send(res, 200, engine.scenarios());
      if (req.method === "GET" && path === "/overview") return send(res, 200, await overview());
      if (req.method === "GET" && path === "/runs/current") return send(res, 200, { run: engine.current() });

      if (req.method === "POST" && (path === "/runs" || path === "/runs/current/abort")) {
        const actor = { id: user.sub, role: user.role, email: user.email };
        const ctx = { actor, ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, requestId: req.headers["x-request-id"] || null };
        if (user.role !== "SYSTEM_ADMIN") {
          audit({ action: path === "/runs" ? "drill.start" : "drill.abort", outcome: "denied", ...ctx });
          return error(res, 403, "FORBIDDEN", "Only SYSTEM_ADMIN can start or abort resilience drills.");
        }
        if (path === "/runs/current/abort") {
          const aborted = engine.abort();
          audit({ action: "drill.abort", outcome: aborted ? "success" : "failure", ...ctx, resource: { type: "drill", id: engine.run?.id || null } });
          return aborted ? send(res, 202, { aborted: true }) : error(res, 409, "NO_ACTIVE_DRILL", "No drill is running.");
        }
        let body;
        try {
          body = await readJson(req);
        } catch {
          return error(res, 400, "INVALID_JSON", "Request body must be JSON: { \"scenarioId\": \"…\" }");
        }
        try {
          const run = engine.start(String(body.scenarioId || ""), { startedBy: user.email || user.sub });
          audit({ action: "drill.start", outcome: "success", ...ctx, resource: { type: "drill", id: run.id, scenario: run.scenarioId } });
          return send(res, 202, { run: run.toJSON() });
        } catch (err) {
          audit({ action: "drill.start", outcome: "failure", ...ctx, details: { scenarioId: String(body.scenarioId || "").slice(0, 60), reason: err.message } });
          if (err instanceof ConflictError) return error(res, 409, "DRILL_IN_PROGRESS", err.message);
          if (err instanceof UnavailableError) return error(res, 503, "DRILLS_UNAVAILABLE", err.message);
          return error(res, 400, "INVALID_SCENARIO", err.message);
        }
      }
      return error(res, 404, "NOT_FOUND", "No such route.");
    } catch (err) {
      console.error(`[${SERVICE_NAME}] unhandled error on ${req.method} ${path}: ${err.message}\n${err.stack}`);
      return error(res, 500, "INTERNAL_ERROR", "An unexpected error occurred.");
    }
  };
}

export function loadConfig(env = process.env) {
  return {
    ...DEFAULT_CONFIG,
    // Phase 12: if a fault-injection token is configured, it must be a real
    // one (>= 32 chars, not an example value). Unset = drills unavailable.
    chaosToken: env.CHAOS_TOKEN ? requireSecret("CHAOS_TOKEN", { env }) : "",
    serviceDomain: env.SERVICE_DOMAIN || "",
    replicas: Number(env.DRILL_REPLICAS || DEFAULT_CONFIG.replicas),
  };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const cfg = loadConfig();
  const namespace = process.env.POD_NAMESPACE || "sentinelcloud";
  const k8s = inClusterAvailable() ? createK8sClient({ namespace }) : null;
  const rabbit = createRabbitAdmin({
    baseUrl: process.env.RABBITMQ_MGMT_URL || "http://rabbitmq:15672",
    user: requireEnv("RABBITMQ_USER"),
    password: requireSecret("RABBITMQ_PASSWORD", { minLength: 16 }),
  });
  const engine = new ResilienceEngine({ scenarios: buildScenarios(), k8s, rabbit, request: httpRequest, cfg });
  const audit = createAuditLogger({ service: SERVICE_NAME });
  const server = http.createServer(createApp({ engine, jwtSecret: requireSecret("JWT_ACCESS_SECRET"), k8s, audit }));
  server.listen(PORT, () => {
    const a = engine.availability();
    console.log(`[${SERVICE_NAME}] listening on port ${PORT} — orchestrator: ${a.orchestrator}, drills ${a.available ? "available" : `unavailable: ${a.reason}`}`);
  });

  // Graceful shutdown: if this pod is stopped mid-drill, abort the drill
  // and let its cleanup run (clear injected faults, restore HPA settings),
  // so a restart of resilience-service never leaves the platform degraded.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[${SERVICE_NAME}] ${signal} received${engine.isRunning() ? " — aborting the running drill and cleaning up" : ""}`);
    setTimeout(() => process.exit(0), 20000).unref();
    engine.abort();
    await engine.settled().catch(() => {});
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
