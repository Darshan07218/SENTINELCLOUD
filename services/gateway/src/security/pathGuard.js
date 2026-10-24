/**
 * Phase 12: one normalised view of every /api/v1 request path, used for
 * every access decision in the gateway.
 *
 * Why: the old checks compared raw strings, while Express mounts and the
 * downstream servers are more forgiving. `/api/v1/HOSPITALS` matched the
 * case-insensitive `app.use("/api/v1/hospitals")` proxy but NOT the
 * case-sensitive role table, so a CITIZEN could POST there; and an
 * encoded segment (`/power/%69nternal/chaos`) can slip past a regex on
 * the raw path and be decoded by the service. Here the path is decoded
 * ONCE, rejected if ambiguous, and every rule runs on the result.
 */

// Segments that are infrastructure endpoints on every service (probes,
// Prometheus scrapes, Spring actuator, fault injection). They are for the
// cluster only and are never proxied, whoever is asking.
export const BLOCKED_FIRST_SEGMENTS = new Set(["health", "metrics", "prometheus", "info", "actuator", "internal"]);

/**
 * analyzeApiPath("/hospitals/42") →
 *   { ok: true, prefix: "hospitals", rest: "/42", normalized: "/hospitals/42" }
 * or { ok: false, status, code, reason }.
 *
 * `relPath` is the path relative to the /api/v1 mount (Express req.path).
 */
export function analyzeApiPath(relPath, knownPrefixes) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return { ok: false, status: 400, code: "BAD_PATH", reason: "malformed percent-encoding" };
  }
  // Characters that have no business in an API path and are classic
  // smuggling tools (backslashes, NUL, other control characters).
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) {
    return { ok: false, status: 400, code: "BAD_PATH", reason: "illegal characters in path" };
  }
  const segments = decoded.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === "." || s === "..")) {
    return { ok: false, status: 400, code: "BAD_PATH", reason: "dot segments are not allowed" };
  }
  const [prefix = "", ...restSegments] = segments;
  // Exact, lower-case prefixes only: no case games with the role table.
  if (!knownPrefixes.has(prefix)) {
    return { ok: false, status: 404, code: "NOT_FOUND", reason: "unknown API prefix" };
  }
  if (segments.some((s) => s.toLowerCase() === "internal")) {
    return { ok: false, status: 404, code: "NOT_FOUND", reason: "internal endpoint" };
  }
  const first = (restSegments[0] || "").toLowerCase();
  if (BLOCKED_FIRST_SEGMENTS.has(first)) {
    return { ok: false, status: 404, code: "NOT_FOUND", reason: "infrastructure endpoint" };
  }
  const rest = restSegments.length ? `/${restSegments.join("/")}` : "/";
  return { ok: true, prefix, rest, normalized: `/${segments.join("/")}` };
}
