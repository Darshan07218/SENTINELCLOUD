/**
 * Phase 12: who may open the live WebSocket feed (/ws/live).
 *
 * A WebSocket upgrade bypasses every Express middleware, so before this
 * phase anyone could connect and receive every event on the bus. Now the
 * gateway checks the handshake itself before proxying it:
 *
 *  1. Path must be exactly /ws/live (no other upgrade paths are proxied).
 *  2. Origin, when the browser sends one, must be an allowed origin or
 *     the same host the request came in on. Browsers don't apply CORS to
 *     WebSockets, so without this any website could open the feed with a
 *     visitor's credentials (cross-site WebSocket hijacking).
 *  3. A valid access token, sent as a WebSocket sub-protocol
 *     ("bearer.<jwt>") because browsers can't set an Authorization header
 *     on a WebSocket. Not in the query string: URLs end up in access logs.
 */

export const LIVE_PATH = "/ws/live";
export const APP_PROTOCOL = "sentinel-live";
const BEARER_PREFIX = "bearer.";

/** Splits "a, b,c" (Sec-WebSocket-Protocol) into ["a","b","c"]. */
export function parseProtocols(header) {
  return String(header || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function tokenFromProtocols(header) {
  const bearer = parseProtocols(header).find((p) => p.startsWith(BEARER_PREFIX));
  return bearer ? bearer.slice(BEARER_PREFIX.length) : null;
}

export function originAllowed(origin, { allowedOrigins, host }) {
  if (!origin) return true; // non-browser clients send no Origin; they still need a token
  if (allowedOrigins.includes(origin)) return true;
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * checkUpgrade(req, { allowedOrigins, verifyToken, trustForwardedHost }) →
 *   { ok: true, user } | { ok: false, status, reason }
 */
export function checkUpgrade(req, { allowedOrigins, verifyToken, trustForwardedHost = false }) {
  const pathname = String(req.url || "").split("?")[0];
  if (pathname !== LIVE_PATH) return { ok: false, status: 404, reason: "unknown WebSocket path" };
  // X-Forwarded-Host only counts when a trusted proxy (nginx) sits in front;
  // otherwise a client could simply send one that matches its Origin.
  const host = (trustForwardedHost && req.headers["x-forwarded-host"]) || req.headers.host;
  if (!originAllowed(req.headers.origin, { allowedOrigins, host })) {
    return { ok: false, status: 403, reason: "origin not allowed" };
  }
  const token = tokenFromProtocols(req.headers["sec-websocket-protocol"]);
  if (!token) return { ok: false, status: 401, reason: "missing access token" };
  try {
    const payload = verifyToken(token);
    return { ok: true, user: { id: payload.sub, role: payload.role } };
  } catch {
    return { ok: false, status: 401, reason: "invalid access token" };
  }
}

/** Ends a raw upgrade socket with a plain HTTP error (no WebSocket was opened). */
export function rejectUpgrade(socket, status) {
  const text = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" }[status] || "Bad Request";
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}
