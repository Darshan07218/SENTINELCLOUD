/**
 * simulator-service (Phase 16): the scenario simulator
 * (docs/PHASE-16-SIMULATOR.md). Plays scripted disasters out over time and,
 * optionally, keeps the city alive in the background. It acts ONLY through
 * the API gateway with its own service account. Zero runtime dependencies.
 *
 * API (through the gateway: /api/v1/simulator/…; JWT required, and writes
 * need SYSTEM_ADMIN at the gateway AND here):
 *   GET  /scenarios            the scenario catalogue
 *   GET  /status               current/last run (steps + narration), background mode, write budget
 *   POST /runs                 { "scenarioId": "monsoon-flood" } → start a scenario
 *   POST /runs/current/stop    stop it (clean-up steps still run)
 *   POST /ambient              { "enabled": true|false } → background activity on/off
 *   GET  /health, /health/ready, /metrics
 */
import http from "node:http";
import { verifyAccessToken, TokenError } from "./security/jwt.js";
import { requireSecret, requireEnv } from "./security/secrets.js";
import { createAuditLogger } from "./security/audit.js";
import { createGatewayClient } from "./gatewayClient.js";
import { createAmbient } from "./ambient.js";
import { createActions, createRunner, ConflictError } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";
import { registry, metricsMiddleware } from "./metrics.js";

const SERVICE_NAME = "simulator-service";
const PORT = Number(process.env.PORT || 8090);

export function createApp({ runner, ambient, client, jwtSecret, audit = () => {} }) {
  registry.gauge("sentinel_simulator_run_active", "1 while a scenario is running.", [], {
    collect: async () => [{ value: runner.isRunning() ? 1 : 0 }],
  });
  registry.gauge("sentinel_simulator_ambient_enabled", "1 while background activity is on.", [], {
    collect: async () => [{ value: ambient.isEnabled() ? 1 : 0 }],
  });

  function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
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
      if (raw.length > 4_000) throw new Error("body too large");
    }
    return raw ? JSON.parse(raw) : {};
  }

  const KNOWN_ROUTES = new Set(["/health", "/health/ready", "/scenarios", "/status", "/runs", "/runs/current/stop", "/ambient"]);
  const WRITES = new Set(["/runs", "/runs/current/stop", "/ambient"]);

  return async function handler(req, res) {
    const url = new URL(req.url, "http://local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    Object.assign(req, { path, baseUrl: "", route: undefined });

    if (path === "/metrics") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return res.end(await registry.render());
    }
    // Unknown paths share one label value, so callers can't mint metric series.
    req.route = { path: KNOWN_ROUTES.has(path) ? path : "unmatched" };
    metricsMiddleware(req, res, () => {});

    try {
      if (req.method === "GET" && path === "/health") return send(res, 200, { status: "ok", service: SERVICE_NAME, timestamp: new Date().toISOString() });
      // Ready = up; the gateway being down only fails individual steps.
      if (req.method === "GET" && path === "/health/ready") return send(res, 200, { status: "ready", service: SERVICE_NAME, timestamp: new Date().toISOString() });

      let user;
      try {
        user = authenticate(req);
      } catch {
        return error(res, 401, "UNAUTHORIZED", "Valid access token required.");
      }

      if (req.method === "GET" && path === "/scenarios") {
        return send(res, 200, { scenarios: SCENARIOS.map(({ steps, ...s }) => ({ ...s, stepCount: steps.length })) });
      }
      if (req.method === "GET" && path === "/status") {
        return send(res, 200, { run: runner.current(), ambient: ambient.status(), budget: client.budget() });
      }

      if (req.method === "POST" && WRITES.has(path)) {
        const ctx = { actor: { id: user.sub, role: user.role, email: user.email }, ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, requestId: req.headers["x-request-id"] || null };
        const action = path === "/runs" ? "simulator.start" : path === "/ambient" ? "simulator.ambient" : "simulator.stop";
        if (user.role !== "SYSTEM_ADMIN") {
          audit({ action, outcome: "denied", ...ctx });
          return error(res, 403, "FORBIDDEN", "Only a SYSTEM_ADMIN can run the simulator.");
        }
        if (path === "/runs/current/stop") {
          const stopped = runner.stop();
          audit({ action, outcome: stopped ? "success" : "failure", ...ctx });
          return stopped ? send(res, 202, { stopping: true }) : error(res, 409, "NO_ACTIVE_RUN", "No scenario is running.");
        }
        let body;
        try {
          body = await readJson(req);
        } catch {
          return error(res, 400, "INVALID_JSON", "Request body must be JSON.");
        }
        if (path === "/ambient") {
          if (typeof body.enabled !== "boolean") return error(res, 400, "VALIDATION_ERROR", '"enabled" must be true or false.');
          const enabled = ambient.setEnabled(body.enabled);
          audit({ action, outcome: "success", ...ctx, details: { enabled } });
          return send(res, 200, { ambient: ambient.status() });
        }
        try {
          const run = runner.start(String(body.scenarioId || ""), { startedBy: user.email || user.sub });
          audit({ action, outcome: "success", ...ctx, resource: { type: "scenario-run", id: run.id, scenario: run.scenarioId } });
          return send(res, 202, { run });
        } catch (err) {
          audit({ action, outcome: "failure", ...ctx, details: { scenarioId: String(body.scenarioId || "").slice(0, 60), reason: err.message } });
          if (err instanceof ConflictError) return error(res, 409, "RUN_IN_PROGRESS", err.message);
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

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const client = createGatewayClient({
    baseUrl: process.env.GATEWAY_URL || "http://gateway:8080/api/v1",
    email: requireEnv("SIMULATOR_EMAIL"),
    password: requireSecret("SIMULATOR_PASSWORD", { minLength: 10 }),
  });
  const ambient = createAmbient({ client });
  const runner = createRunner({ actions: createActions({ client }), ambient, scenarios: SCENARIOS });
  const audit = createAuditLogger({ service: SERVICE_NAME });
  const server = http.createServer(createApp({ runner, ambient, client, jwtSecret: requireSecret("JWT_ACCESS_SECRET"), audit }));
  server.listen(PORT, () => console.log(`[${SERVICE_NAME}] listening on port ${PORT} — ${SCENARIOS.length} scenarios, background mode off`));

  // Graceful shutdown: stop the run (its clean-up steps still run) before exiting.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[${SERVICE_NAME}] ${signal} received${runner.isRunning() ? " — stopping the scenario and running its clean-up" : ""}`);
    setTimeout(() => process.exit(0), 25000).unref();
    ambient.setEnabled(false);
    runner.stop();
    await runner.settled().catch(() => {});
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
