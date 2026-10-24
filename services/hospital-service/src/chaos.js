/**
 * Phase 11 — controlled fault injection for the Resilience Demo.
 *
 * This is SOFTWARE fault injection inside SentinelCloud's own process:
 * it makes this one pod misbehave so the Resilience Demo can show how
 * Kubernetes detects and recovers from it. It doesn't touch any real
 * infrastructure, and it's off unless CHAOS_ENABLED=true AND the
 * caller presents the shared CHAOS_TOKEN.
 *
 * Endpoints (all under /internal/, which the gateway refuses to proxy,
 * so they're reachable only from inside the cluster — in practice only
 * resilience-service calls them, by pod IP or through the Service):
 *
 *   POST /internal/chaos?mode=unhealthy  simulate a hung process: every
 *        request (API, /health, /health/ready, /metrics) now returns 503.
 *        → readiness probe fails (~15s): pod removed from the Service's
 *          endpoints, traffic goes to the other replicas
 *        → liveness probe fails (~30s): kubelet restarts the container,
 *          and the restart clears this in-memory fault (= recovery)
 *   POST /internal/chaos?mode=crash      the process exits with code 1
 *        (kubelet restarts the container immediately)
 *   POST /internal/chaos?mode=clear      undo "unhealthy" (used for cleanup)
 *   GET  /internal/whoami                { pod, service } — lets the demo show
 *        WHICH replica answered a request sent through the Service
 *   GET  /internal/work?ms=40            burn CPU for up to 500ms — stands in
 *        for an expensive emergency computation, used by the traffic-surge
 *        scenario to drive the HPA
 *
 * Framework-agnostic on purpose (plain Node req/res + query string, no
 * body parsing), so the same file works under Express and in tests.
 * Uses no dependencies.
 */
import os from "node:os";
import { timingSafeEqual } from "node:crypto";

export const CHAOS_MODES = Object.freeze(["unhealthy", "crash", "clear"]);
const MAX_WORK_MS = 500;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function tokensMatch(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {object} opts
 * @param {string} opts.serviceName
 * @param {boolean} [opts.enabled]  default: process.env.CHAOS_ENABLED === "true"
 * @param {string}  [opts.token]    default: process.env.CHAOS_TOKEN
 * @param {(code:number)=>void} [opts.exit]  default: process.exit (injectable for tests)
 * @param {() => string} [opts.hostname]
 */
export function createChaos({
  serviceName,
  enabled = process.env.CHAOS_ENABLED === "true",
  token = process.env.CHAOS_TOKEN || "",
  exit = (code) => process.exit(code),
  hostname = () => os.hostname(),
} = {}) {
  const active = Boolean(enabled && token);
  let fault = null; // { mode, since }

  if (active) {
    console.log(`[${serviceName}] fault injection ENABLED (Phase 11 Resilience Demo) — /internal/* requires X-Chaos-Token`);
  }

  function failureBody() {
    return {
      error: {
        code: "SIMULATED_FAILURE",
        message: `${serviceName} pod ${hostname()} is in a simulated failure state (Resilience Demo).`,
      },
      pod: hostname(),
      fault,
    };
  }

  function middleware(req, res, next) {
    const url = new URL(req.originalUrl || req.url, "http://local");
    const path = url.pathname;

    if (path.startsWith("/internal/")) {
      // Disabled, or wrong/missing token: behave exactly like an unknown route.
      if (!active || !tokensMatch(req.headers["x-chaos-token"], token)) {
        return send(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${req.method} ${path}` } });
      }

      if (path === "/internal/chaos" && req.method === "POST") {
        const mode = url.searchParams.get("mode");
        if (!CHAOS_MODES.includes(mode)) {
          return send(res, 400, { error: { code: "INVALID_MODE", message: `mode must be one of ${CHAOS_MODES.join(", ")}` } });
        }
        if (mode === "clear") {
          fault = null;
          console.log(`[${serviceName}] fault cleared`);
          return send(res, 200, { pod: hostname(), service: serviceName, fault });
        }
        if (mode === "crash") {
          console.warn(`[${serviceName}] SIMULATED CRASH requested — exiting with code 1`);
          send(res, 202, { pod: hostname(), service: serviceName, fault: { mode, since: new Date().toISOString() } });
          setTimeout(() => exit(1), 100); // let the 202 flush first
          return undefined;
        }
        fault = { mode, since: new Date().toISOString() };
        console.warn(`[${serviceName}] SIMULATED FAILURE: pod is now "${mode}" — all requests return 503 until the container restarts`);
        return send(res, 200, { pod: hostname(), service: serviceName, fault });
      }

      // While faulty, the diagnostic endpoints fail too (a hung process answers nothing).
      if (fault) return send(res, 503, failureBody());

      if (path === "/internal/whoami" && req.method === "GET") {
        return send(res, 200, { pod: hostname(), service: serviceName, fault: null });
      }
      if (path === "/internal/work" && req.method === "GET") {
        const ms = Math.min(MAX_WORK_MS, Math.max(1, Number(url.searchParams.get("ms")) || 20));
        const end = Date.now() + ms;
        let x = 0;
        while (Date.now() < end) x += Math.sqrt(x + 1); // deliberately CPU-bound
        return send(res, 200, { pod: hostname(), service: serviceName, ms });
      }
      return send(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${req.method} ${path}` } });
    }

    if (fault) return send(res, 503, failureBody());
    return next();
  }

  return {
    middleware,
    isEnabled: () => active,
    currentFault: () => fault,
  };
}
