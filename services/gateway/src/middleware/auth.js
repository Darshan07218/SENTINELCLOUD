import jwt from "jsonwebtoken";
import { requireSecret } from "../security/secrets.js";

// Phase 12: must be set, long and not an example value (see SECURITY.md).
const ACCESS_SECRET = requireSecret("JWT_ACCESS_SECRET");
const ISSUER = "sentinelcloud-auth-service";

/**
 * Verifies an access token locally (same secret auth-service signs with)
 * rather than calling back into auth-service on every proxied request.
 * This is the main reason access tokens are short-lived (15 min default):
 * a valid, unexpired token is trusted without a per-request lookup, so a
 * role change or deactivation applies once the token expires.
 *
 * Phase 12: the algorithm is pinned to HS256, so a token claiming "none"
 * or another algorithm is rejected outright.
 */
export function verifyAccessToken(token) {
  const payload = jwt.verify(token, ACCESS_SECRET, { issuer: ISSUER, algorithms: ["HS256"] });
  if (payload.type !== "access") throw new Error("wrong token type");
  if (!payload.sub || !payload.role) throw new Error("incomplete token");
  return payload;
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "Missing or malformed Authorization header." },
    });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    const message = err.name === "TokenExpiredError" ? "Access token has expired." : "Invalid access token.";
    return res.status(401).json({ error: { code: "UNAUTHENTICATED", message } });
  }
}

/**
 * Role gate — must run after requireAuth (relies on req.user). Returns
 * 403 (not 401): the request is authenticated, it's just not permitted
 * for this account's role.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: { code: "FORBIDDEN", message: "Your role is not permitted to perform this action." },
      });
    }
    next();
  };
}
