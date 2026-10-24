/**
 * HS256 access-token verification with node:crypto only (no npm
 * dependency), for services that don't otherwise need `jsonwebtoken`
 * (notification-service, resilience-service).
 *
 * Accepts exactly what auth-service issues: alg HS256 (never "none" or
 * anything else), issuer "sentinelcloud-auth-service", type "access",
 * a subject, and an expiry that has not passed.
 *
 * Canonical copy: shared/node-security/jwt.js.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ISSUER = "sentinelcloud-auth-service";

function b64urlDecode(segment) {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export class TokenError extends Error {}

export function verifyAccessToken(token, secret, { now = Date.now() } = {}) {
  if (!secret) throw new TokenError("server has no JWT_ACCESS_SECRET configured");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new TokenError("malformed token");
  const [h, p, s] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(h).toString("utf8"));
    payload = JSON.parse(b64urlDecode(p).toString("utf8"));
  } catch {
    throw new TokenError("malformed token");
  }
  if (header?.alg !== "HS256") throw new TokenError("unsupported alg"); // rejects "none" and alg confusion
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const given = b64urlDecode(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TokenError("bad signature");
  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== "number") throw new TokenError("token has no expiry");
  if (nowSec >= payload.exp) throw new TokenError("token expired");
  if (typeof payload.nbf === "number" && nowSec < payload.nbf) throw new TokenError("token not yet valid");
  if (payload.iss !== ISSUER) throw new TokenError("wrong issuer");
  if (payload.type !== "access") throw new TokenError("not an access token");
  if (typeof payload.sub !== "string" || !payload.sub) throw new TokenError("token has no subject");
  return payload;
}

/** Extracts the token from "Authorization: Bearer <token>", or null. */
export function bearerToken(authorizationHeader) {
  const [scheme, token] = String(authorizationHeader || "").split(" ");
  return scheme === "Bearer" && token ? token : null;
}
