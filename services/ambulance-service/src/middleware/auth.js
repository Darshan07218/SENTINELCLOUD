import jwt from "jsonwebtoken";
import { requireSecret } from "../security/secrets.js";

// Phase 12: must be set, at least 32 chars and not an example value.
const ACCESS_SECRET = requireSecret("JWT_ACCESS_SECRET");

/**
 * The gateway is the primary enforcement point (see
 * services/gateway/src/middleware/auth.js) and already verifies the
 * token + coarse role before proxying here. ambulance-service verifies
 * independently anyway — in local dev its port (8082) is reachable
 * directly, and this is also where the *fine-grained* check lives
 * (does this specific user manage *this specific* hospital — see
 * middleware/ownership.js), which the gateway has no way to know.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "Missing or malformed Authorization header." },
    });
  }

  try {
    const payload = jwt.verify(token, ACCESS_SECRET, { issuer: "sentinelcloud-auth-service", algorithms: ["HS256"] });
    if (payload.type !== "access") throw new Error("wrong token type");
    // Same claims every other verifier requires (shared/node-security/jwt.js).
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.role !== "string") throw new Error("missing claims");
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    const message = err.name === "TokenExpiredError" ? "Access token has expired." : "Invalid access token.";
    return res.status(401).json({ error: { code: "UNAUTHENTICATED", message } });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "Your role is not permitted to perform this action.",
        },
      });
    }
    next();
  };
}
