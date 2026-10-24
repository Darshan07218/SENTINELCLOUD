import { verifyAccessToken } from "../utils/jwt.js";

/**
 * The gateway is the primary enforcement point for the rest of the
 * system (see services/gateway/src/middleware/auth.js), but
 * auth-service protects its own sensitive routes independently too —
 * defense in depth means a misconfigured gateway route should never be
 * the only thing standing between a request and a protected endpoint.
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
    const payload = verifyAccessToken(token);
    if (payload.type !== "access") {
      throw new Error("wrong token type");
    }
    // Same claims every other verifier requires (shared/node-security/jwt.js).
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.role !== "string") {
      throw new Error("missing claims");
    }
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    const message = err.name === "TokenExpiredError" ? "Access token has expired." : "Invalid access token.";
    return res.status(401).json({ error: { code: "UNAUTHENTICATED", message } });
  }
}

/** Phase 12: role gate for the user-management endpoints. Run after requireAuth. */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required." } });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Your role is not permitted to perform this action." } });
    }
    next();
  };
}
