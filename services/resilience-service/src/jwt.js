// Phase 12: the verifier now lives in the shared, stricter module
// (requires exp, type "access" and sub). Kept as a re-export so existing
// imports keep working.
export { verifyAccessToken, TokenError, bearerToken } from "./security/jwt.js";
