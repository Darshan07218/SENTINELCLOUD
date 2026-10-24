/**
 * Phase 12: structured audit log.
 *
 * One JSON object per line on stdout, marked {"log":"audit"} so it can be
 * filtered from ordinary application logs:
 *
 *   kubectl logs -n sentinelcloud deploy/gateway | grep '"log":"audit"'
 *
 * Who did what, to which resource, from where, and whether it worked.
 * Never the request body, passwords, tokens, cookies or Authorization
 * headers: `details` is passed through `sanitize`, which drops any key
 * that looks secret and strips control characters (no log injection).
 *
 * Canonical copy: shared/node-security/audit.js.
 */

const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|hash/i;
const MAX_STRING = 300;
const MAX_DEPTH = 4;

export function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ");
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…` : clean;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * createAuditLogger({ service }) → audit({ action, outcome, actor, ip, requestId, resource, details })
 *   action   e.g. "auth.login", "http.write", "drill.start"
 *   outcome  "success" | "failure" | "denied"
 *   actor    { id, role, email? } or null for anonymous
 */
export function createAuditLogger({ service, write = (line) => process.stdout.write(`${line}\n`), now = () => new Date() }) {
  return function audit({ action, outcome = "success", actor = null, ip = null, requestId = null, resource = null, details = null }) {
    const entry = {
      log: "audit",
      ts: now().toISOString(),
      service,
      action,
      outcome,
      actor: actor ? sanitize({ id: actor.id ?? null, role: actor.role ?? null, email: actor.email ?? undefined }) : null,
      ip: ip ? sanitize(ip) : null,
      requestId: requestId ? sanitize(requestId) : null,
      resource: resource ? sanitize(resource) : null,
      details: details ? sanitize(details) : null,
    };
    try {
      write(JSON.stringify(entry));
    } catch {
      // Never let logging break a request.
    }
    return entry;
  };
}
