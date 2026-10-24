import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { requireSecret } from "../security/secrets.js";

// Phase 12: both secrets must be set, at least 32 characters, and not an
// example value — the service refuses to start otherwise (SECURITY.md).
const ACCESS_SECRET = requireSecret("JWT_ACCESS_SECRET");
const REFRESH_SECRET = requireSecret("JWT_REFRESH_SECRET");
if (ACCESS_SECRET === REFRESH_SECRET) {
  throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different secrets.");
}
const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "15m";
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "7d";
const ISSUER = "sentinelcloud-auth-service";
// Phase 12: one algorithm, everywhere. Verification refuses anything else
// (including "none"), which closes algorithm-confusion attacks for good.
const ALGORITHM = "HS256";

/**
 * Access tokens are short-lived and carry the claims every downstream
 * check needs (user id, email, role) so the gateway and services can
 * verify + authorize a request without calling back into auth-service.
 */
export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, type: "access" }, ACCESS_SECRET, {
    expiresIn: ACCESS_EXPIRES_IN,
    issuer: ISSUER,
    algorithm: ALGORITHM,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET, { issuer: ISSUER, algorithms: [ALGORITHM] });
}

/**
 * Refresh tokens carry minimal claims (just the user id + a unique jti).
 * Every refresh token's SHA-256 hash is also stored server-side (see
 * repositories/refreshTokenRepository.js) so it can be revoked.
 */
export function signRefreshToken(user, jti) {
  return jwt.sign({ sub: user.id, jti, type: "refresh" }, REFRESH_SECRET, {
    expiresIn: REFRESH_EXPIRES_IN,
    issuer: ISSUER,
    algorithm: ALGORITHM,
  });
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET, { issuer: ISSUER, algorithms: [ALGORITHM] });
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function lifetimeSeconds(secret, expiresIn) {
  const decoded = jwt.decode(jwt.sign({ sub: "expiry-probe" }, secret, { expiresIn, algorithm: ALGORITHM }));
  return decoded.exp - decoded.iat;
}

/** Access-token lifetime in seconds, so the frontend can refresh proactively. */
export function getAccessTokenExpirySeconds() {
  return lifetimeSeconds(ACCESS_SECRET, ACCESS_EXPIRES_IN);
}

/** Refresh-token lifetime in seconds (the refresh cookie's Max-Age). */
export function getRefreshTokenExpirySeconds() {
  return lifetimeSeconds(REFRESH_SECRET, REFRESH_EXPIRES_IN);
}
