/**
 * Phase 12: the refresh token lives in an httpOnly cookie, not in the
 * browser's localStorage. JavaScript (including any injected script)
 * can't read an httpOnly cookie, so an XSS bug can no longer steal a
 * 7-day session. SameSite=Strict keeps other sites from sending it, and
 * the Path limits it to the auth endpoints that need it.
 *
 * No cookie-parser dependency: one cookie, parsed with a few lines.
 */
export const REFRESH_COOKIE = "sc_refresh";

export function cookieOptionsFromEnv(env = process.env) {
  return {
    // The path the BROWSER sees (through the gateway), not this service's own path.
    path: env.REFRESH_COOKIE_PATH || "/api/v1/auth",
    // Secure by default. Local HTTP setups set COOKIE_SECURE=false explicitly.
    secure: env.COOKIE_SECURE !== "false",
  };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function serializeRefreshCookie(value, { maxAgeSeconds, path, secure }) {
  const attrs = [
    `${REFRESH_COOKIE}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearRefreshCookie({ path, secure }) {
  return serializeRefreshCookie("", { maxAgeSeconds: 0, path, secure });
}
