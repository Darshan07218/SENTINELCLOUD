/**
 * Central table of "who can do what" at the gateway layer, kept in one
 * place so the whole system's access policy can be read and reviewed
 * at once.
 *
 * How it's applied (see index.js). Every path here is RELATIVE to
 * /api/v1 and has already been decoded and checked by
 * security/pathGuard.js (Phase 12), so case tricks, encoded segments and
 * "../" can't change which rule applies.
 *   1. Exact public paths (register, login, refresh, logout, auth API docs)
 *      skip authentication. Logout is public so a client whose access token
 *      has expired can still end its session with its refresh cookie.
 *   2. Everything else requires a valid access token (requireAuth).
 *   3. Write methods (POST/PUT/PATCH/DELETE) additionally require the
 *      caller's role to be in that prefix's write-role list. Unknown
 *      prefixes get an EMPTY list: fail closed, not open.
 *   4. Reads (GET) only need step 2 — every role can read. Services then
 *      apply their own finer checks (ownership, per-endpoint roles).
 */

export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const PUBLIC_EXACT = new Set(["/auth/register", "/auth/login", "/auth/refresh", "/auth/logout", "/auth/openapi.json"]);
const PUBLIC_PREFIXES = ["/auth/docs/"];

export function isPublicPath(normalizedRelPath) {
  const p = normalizedRelPath.length > 1 ? normalizedRelPath.replace(/\/+$/, "") : normalizedRelPath;
  if (PUBLIC_EXACT.has(p)) return true;
  if (p === "/auth/docs") return true;
  return PUBLIC_PREFIXES.some((prefix) => normalizedRelPath.startsWith(prefix) && !normalizedRelPath.includes(".."));
}

/** Marker: any authenticated role may write; the service enforces finer rules itself. */
export const ANY_AUTHENTICATED = "ANY_AUTHENTICATED";

// SYSTEM_ADMIN is included everywhere: it has full read/write across all
// domains per the architecture's role table.
export const WRITE_ROLES_BY_PREFIX = {
  // auth-service: /logout is public (above); /users (user management) is
  // SYSTEM_ADMIN-only and enforced inside auth-service.
  auth: ANY_AUTHENTICATED,
  hospitals: ["HOSPITAL_ADMIN", "SYSTEM_ADMIN"],
  ambulances: ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"],
  "blood-banks": ["HOSPITAL_ADMIN", "SYSTEM_ADMIN"],
  power: ["INFRASTRUCTURE_ADMIN", "SYSTEM_ADMIN"],
  disasters: ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"],
  // Phase 14: the only write is POST /notifications/dead-letters/replay.
  // Reading the dead letters (GET) is SYSTEM_ADMIN-only too, enforced
  // inside notification-service like auth-service's /users.
  notifications: ["SYSTEM_ADMIN"],
  // Phase 11: starting/aborting a resilience drill deliberately breaks
  // parts of the platform, so only SYSTEM_ADMIN may do it.
  resilience: ["SYSTEM_ADMIN"],
  // Phase 15: approving, rejecting and undoing response plans moves real
  // ambulances and blood — the same people who run disasters.
  response: ["EMERGENCY_OPERATOR", "SYSTEM_ADMIN"],
  // Phase 16: starting a scenario drives the whole platform; SYSTEM_ADMIN only.
  simulator: ["SYSTEM_ADMIN"],
};

/** Roles allowed to write under `prefix`; [] (nobody) for anything unknown. */
export function writeRolesFor(prefix) {
  return Object.prototype.hasOwnProperty.call(WRITE_ROLES_BY_PREFIX, prefix) ? WRITE_ROLES_BY_PREFIX[prefix] : [];
}
