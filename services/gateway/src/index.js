import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";
import { connectBroker, isBrokerConnected, getBrokerError } from "./broker.js";
import { requireAuth, requireRole, verifyAccessToken } from "./middleware/auth.js";
import { isPublicPath, WRITE_METHODS, writeRolesFor, ANY_AUTHENTICATED } from "./routeAccessRules.js";
import { metricsMiddleware, metricsHandler, registerDependencyCheck } from "./metrics.js";
import { analyzeApiPath } from "./security/pathGuard.js";
import { createRateLimiter } from "./security/rateLimiter.js";
import { checkUpgrade, rejectUpgrade } from "./security/wsAuth.js";
import { createAuditLogger } from "./security/audit.js";

const PORT = process.env.PORT || 8080;
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";

// Downstream service base URLs. In Docker Compose these resolve via the
// built-in DNS (container name == hostname). In Kubernetes (Phase 9)
// the same short names resolve via CoreDNS to each ClusterIP Service,
// which load-balances across every ready replica.
const SERVICES = {
  auth: process.env.AUTH_SERVICE_URL || "http://auth-service:8081",
  hospitals: process.env.HOSPITAL_SERVICE_URL || "http://hospital-service:8082",
  ambulances: process.env.AMBULANCE_SERVICE_URL || "http://ambulance-service:8083",
  "blood-banks": process.env.BLOOD_BANK_SERVICE_URL || "http://blood-bank-service:8084",
  power: process.env.POWER_SERVICE_URL || "http://power-service:8085",
  disasters: process.env.DISASTER_SERVICE_URL || "http://disaster-service:8086",
  // REST bootstrap for the dashboard (GET /events/recent); the live feed
  // itself is the separate /ws/live WebSocket proxy below.
  notifications: process.env.NOTIFICATION_SERVICE_URL || "http://notification-service:8087",
  // Phase 11: Resilience Demo control plane (admin-only for writes).
  resilience: process.env.RESILIENCE_SERVICE_URL || "http://resilience-service:8088",
  // Phase 15: the automated response engine (response plans: approve/reject/undo).
  response: process.env.RESPONSE_SERVICE_URL || "http://response-service:8089",
  // Phase 16: the scenario simulator (admin-only for writes).
  simulator: process.env.SIMULATOR_SERVICE_URL || "http://simulator-service:8090",
};
const KNOWN_PREFIXES = new Set(Object.keys(SERVICES));

const NOTIFICATION_SERVICE_WS = process.env.NOTIFICATION_SERVICE_WS_URL || "ws://notification-service:8087";

// ---------------------------------------------------------------------
// Phase 12 settings (all from the gateway ConfigMap / .env)
// ---------------------------------------------------------------------
// Browser origins allowed to call the API cross-origin (with the refresh
// cookie) and to open the live WebSocket. Same-origin requests (the
// frontend served by nginx on :30080 in Kubernetes) never need listing.
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
// How many reverse proxies sit in front of the gateway and may set
// X-Forwarded-For: 1 in Kubernetes (the frontend's nginx), 0 in Docker
// Compose (browsers talk to the gateway directly). Trusting more hops than
// really exist lets a client spoof its IP and dodge the rate limits.
const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "0", 10) || 0;
const RATE_LIMIT_API_PER_MINUTE = Number(process.env.RATE_LIMIT_API_PER_MINUTE || 600);
const RATE_LIMIT_WRITES_PER_MINUTE = Number(process.env.RATE_LIMIT_WRITES_PER_MINUTE || 60);
const RATE_LIMIT_WS_PER_MINUTE = Number(process.env.RATE_LIMIT_WS_PER_MINUTE || 30);

const audit = createAuditLogger({ service: "gateway" });

const app = express();
app.set("trust proxy", TRUST_PROXY_HOPS);
app.disable("x-powered-by");

// Request id: accepted from the caller if it looks sane, else generated;
// returned in X-Request-Id, forwarded to the service and written into
// every audit line, so one request can be followed through the logs.
app.use((req, res, next) => {
  const incoming = req.headers["x-request-id"];
  req.id = typeof incoming === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
});

// Phase 10: time every request (registered before all routes, so auth
// rejections, 404s and proxied calls are all counted). Exposed at /metrics.
app.use(metricsMiddleware);

app.use(helmet());
app.use(
  cors({
    origin: CORS_ALLOWED_ORIGINS,
    credentials: true, // the refresh-token cookie (auth-service) needs it cross-origin
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"],
    maxAge: 600,
  })
);
// Access log WITHOUT query strings: they can carry locations and search
// terms, and nothing in this API needs them for debugging.
morgan.token("path", (req) => String(req.originalUrl || req.url).split("?")[0]);
morgan.token("rid", (req) => req.id);
app.use(morgan(":method :path :status :res[content-length] - :response-time ms rid=:rid"));

const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";
const actorOf = (req) => (req.user ? { id: req.user.id, role: req.user.role } : null);

// ---------------------------------------------------------------------
// Health endpoints (cluster probes; /health and /health/services are
// also reachable through the frontend's nginx)
// ---------------------------------------------------------------------
// Phase 10: Prometheus scrape endpoint. Cluster-internal: nginx only
// proxies /api, /ws and /health, and a NetworkPolicy (Phase 12) lets only
// Prometheus and the frontend reach the gateway pod at all.
app.get("/metrics", metricsHandler);
registerDependencyCheck("rabbitmq", () => isBrokerConnected());

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "gateway", timestamp: new Date().toISOString() });
});

// Readiness: RabbitMQ is REPORTED but not REQUIRED (Phase 10) — the
// gateway only proxies HTTP, so a broker outage must not pull the whole
// API out of rotation.
app.get("/health/ready", (req, res) => {
  const brokerOk = isBrokerConnected();
  res.status(200).json({
    status: "ready",
    dependencies: {
      rabbitmq: brokerOk ? "connected" : `disconnected (${getBrokerError() || "not yet connected"}, non-blocking)`,
    },
    timestamp: new Date().toISOString(),
  });
});

// Aggregated health for the dashboard's "system health" panel. Phase 12:
// this is public, so it reports ONLY up/degraded/down per service — not
// the services' own health bodies (Spring's include versions and disk
// paths) or raw error messages (internal hostnames and IPs).
// Engineering review: probes each service's READINESS endpoint (did it
// reach its database/broker?) instead of /health (is the process alive?),
// so "up" means "can serve requests". Spring Boot exposes readiness at
// /health/readiness, the Node services at /health/ready.
const READINESS_PATH = { "blood-banks": "/health/readiness", power: "/health/readiness" };
// The dashboard polls this every few seconds from every open tab; one
// shared result per 5 s keeps that from multiplying into 8 probes per tab.
const SERVICE_HEALTH_TTL_MS = 5000;
let serviceHealthCache = { at: 0, body: null, pending: null };

async function probeAllServices() {
  const results = await Promise.all(
    Object.entries(SERVICES).map(async ([name, baseUrl]) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${baseUrl}${READINESS_PATH[name] || "/health/ready"}`, { signal: controller.signal });
        await response.body?.cancel();
        return [name, response.ok ? { status: "up" } : { status: "degraded", error: `HTTP ${response.status}` }];
      } catch (err) {
        return [name, { status: "down", error: err.name === "AbortError" ? "timed out" : "unreachable" }];
      } finally {
        clearTimeout(timeout);
      }
    })
  );
  return { gateway: "ok", checkedAt: new Date().toISOString(), services: Object.fromEntries(results) };
}

app.get("/health/services", async (req, res) => {
  const now = Date.now();
  if (!serviceHealthCache.body || now - serviceHealthCache.at >= SERVICE_HEALTH_TTL_MS) {
    if (!serviceHealthCache.pending) {
      serviceHealthCache.pending = probeAllServices()
        .then((body) => {
          serviceHealthCache = { at: Date.now(), body, pending: null };
          return body;
        })
        .catch((err) => {
          serviceHealthCache.pending = null;
          throw err;
        });
    }
    try {
      await serviceHealthCache.pending;
    } catch {
      return res.status(503).json({ gateway: "ok", error: "health check failed" });
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(serviceHealthCache.body);
});

// ---------------------------------------------------------------------
// /api/v1 security pipeline (Phase 12). Order matters:
//   1. audit trail hook (records the outcome when the response finishes)
//   2. per-IP rate limit
//   3. path guard: decode + normalise once; block internal/infra paths
//   4. authentication (except exact public paths)
//   5. write-role check (fail closed) + per-user write rate limit
//   6. proxy
// ---------------------------------------------------------------------
app.use("/api/v1", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.on("finish", () => {
    const status = res.statusCode;
    if (status === 429) return; // already audited by the limiter
    const isWrite = WRITE_METHODS.has(req.method);
    const denied = status === 401 || status === 403;
    if (!isWrite && !denied) return;
    audit({
      action: isWrite ? "http.write" : "http.denied",
      outcome: denied ? "denied" : status < 400 ? "success" : "failure",
      actor: actorOf(req),
      ip: clientIp(req),
      requestId: req.id,
      resource: { method: req.method, path: req.apiPath?.normalized || String(req.originalUrl).split("?")[0], status },
    });
  });
  next();
});

const onLimited = (req, info) =>
  audit({
    action: "ratelimit.exceeded",
    outcome: "denied",
    actor: actorOf(req),
    ip: clientIp(req),
    requestId: req.id,
    resource: { method: req.method, path: String(req.originalUrl).split("?")[0] },
    details: { limiter: info.name, limit: info.limit, windowSeconds: info.windowMs / 1000 },
  });

app.use(
  "/api/v1",
  createRateLimiter({ name: "api-per-ip", windowMs: 60_000, limit: RATE_LIMIT_API_PER_MINUTE, keyFn: clientIp, onLimited })
);

app.use("/api/v1", (req, res, next) => {
  if (req.method === "OPTIONS") return next(); // CORS preflight, answered by cors() above
  const analysis = analyzeApiPath(req.path, KNOWN_PREFIXES);
  if (!analysis.ok) {
    if (analysis.code === "NOT_FOUND" && analysis.reason !== "unknown API prefix") {
      // Someone asked for an internal or infrastructure endpoint from outside: worth a record.
      audit({ action: "http.blocked", outcome: "denied", ip: clientIp(req), requestId: req.id, resource: { method: req.method, path: req.path }, details: { reason: analysis.reason } });
    }
    return res.status(analysis.status).json({ error: { code: analysis.code, message: analysis.status === 404 ? "No such route." : "Malformed request path." } });
  }
  req.apiPath = analysis;
  return next();
});

app.use("/api/v1", (req, res, next) => {
  if (req.method === "OPTIONS" || isPublicPath(req.apiPath.normalized)) return next();
  return requireAuth(req, res, next);
});

const writeLimiter = createRateLimiter({
  name: "writes-per-user",
  windowMs: 60_000,
  limit: RATE_LIMIT_WRITES_PER_MINUTE,
  keyFn: (req) => (req.user ? `user:${req.user.id}` : null),
  onLimited,
});

app.use("/api/v1", (req, res, next) => {
  if (!WRITE_METHODS.has(req.method) || isPublicPath(req.apiPath.normalized)) return next();
  const roles = writeRolesFor(req.apiPath.prefix);
  const afterRoleCheck = () => writeLimiter(req, res, next);
  if (roles === ANY_AUTHENTICATED) return afterRoleCheck();
  return requireRole(...roles)(req, res, afterRoleCheck);
});

// ---------------------------------------------------------------------
// Proxy routes: /api/v1/<prefix>/* → the matching service.
// ---------------------------------------------------------------------
for (const [prefix, target] of Object.entries(SERVICES)) {
  app.use(
    `/api/v1/${prefix}`,
    createProxyMiddleware({
      target,
      changeOrigin: true,
      // Phase 12: NOT xfwd. xfwd APPENDS to whatever X-Forwarded-For the
      // client sent, so a client could spoof its IP to auth-service's login
      // limiter. Instead the gateway SETS the header to the one client IP
      // it determined itself (honouring only TRUST_PROXY_HOPS proxies).
      xfwd: false,
      pathRewrite: { [`^/api/v1/${prefix}`]: "" },
      on: {
        proxyReq: (proxyReq, req) => {
          proxyReq.setHeader("X-Forwarded-For", clientIp(req));
          proxyReq.setHeader("X-Forwarded-Proto", req.protocol);
          proxyReq.setHeader("X-Request-Id", req.id);
          proxyReq.removeHeader("Forwarded");
          // Never let an outside caller hand a service the fault-injection token.
          proxyReq.removeHeader("X-Chaos-Token");
        },
        error: (err, req, res) => {
          console.error(`[gateway] proxy error for ${prefix} (rid=${req.id}):`, err.message);
          if (!res.headersSent) {
            res.status(502).json({ error: { code: "BAD_GATEWAY", message: `${prefix} service is unreachable` } });
          }
        },
      },
    })
  );
}

// WebSocket proxy for the live feed. The upgrade itself is checked in
// the "upgrade" handler below — a WebSocket handshake bypasses every
// Express middleware above.
const wsProxy = createProxyMiddleware({
  target: NOTIFICATION_SERVICE_WS,
  ws: true,
  changeOrigin: true,
});

app.use((req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "No such route." } });
});

// ---------------------------------------------------------------------
// Startup — retry the broker connection forever with capped backoff
// (Phase 9), reconnecting automatically if RabbitMQ restarts.
// ---------------------------------------------------------------------
async function connectBrokerWithRetry(onConnected) {
  for (let attempt = 1; ; attempt++) {
    try {
      await connectBroker(RABBITMQ_URL, { onClose: () => handleBrokerLost(onConnected) });
      break;
    } catch (err) {
      const delayMs = Math.min(2000 * attempt, 15000);
      console.log(`[gateway] RabbitMQ not ready (attempt ${attempt}: ${err.message}), retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (onConnected) {
    try {
      await onConnected();
    } catch (err) {
      console.error(`[gateway] failed to register RabbitMQ consumers, exiting for a clean restart:`, err.message);
      process.exit(1);
    }
  }
  return true;
}

function handleBrokerLost(onConnected) {
  console.warn(`[gateway] RabbitMQ connection lost — reconnecting`);
  setTimeout(() => connectBrokerWithRetry(onConnected), 1000);
}

const server = app.listen(PORT, () => {
  console.log(`[gateway] listening on port ${PORT} (trusting ${TRUST_PROXY_HOPS} proxy hop(s); CORS origins: ${CORS_ALLOWED_ORIGINS.join(", ") || "none"})`);
});

// Phase 12: authenticated, origin-checked, rate-limited WebSocket upgrades.
const wsLimiter = createRateLimiter({ name: "ws-upgrades-per-ip", windowMs: 60_000, limit: RATE_LIMIT_WS_PER_MINUTE, keyFn: (r) => r.key });
server.on("upgrade", (req, socket, head) => {
  // Same client-IP rule as Express: only the last TRUST_PROXY_HOPS entries are trusted.
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = TRUST_PROXY_HOPS > 0 && forwarded.length ? forwarded[Math.max(0, forwarded.length - TRUST_PROXY_HOPS)] : socket.remoteAddress;
  if (!wsLimiter.hit(ip).allowed) {
    audit({ action: "ratelimit.exceeded", outcome: "denied", ip, details: { limiter: "ws-upgrades-per-ip" } });
    return rejectUpgrade(socket, 429);
  }
  const verdict = checkUpgrade(req, { allowedOrigins: CORS_ALLOWED_ORIGINS, verifyToken: verifyAccessToken, trustForwardedHost: TRUST_PROXY_HOPS > 0 });
  if (!verdict.ok) {
    audit({ action: "ws.connect", outcome: "denied", ip, resource: { path: String(req.url).split("?")[0] }, details: { reason: verdict.reason } });
    return rejectUpgrade(socket, verdict.status);
  }
  req.headers["x-forwarded-for"] = ip;
  return wsProxy.upgrade(req, socket, head);
});

// Phase 9: graceful shutdown (Node as PID 1 ignores SIGTERM by default).
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gateway] ${signal} received — draining in-flight requests and shutting down`);
  setTimeout(() => process.exit(0), 8000).unref();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

connectBrokerWithRetry();
