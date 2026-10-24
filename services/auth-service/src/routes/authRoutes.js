import { Router } from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { validateBody, validateQuery, validateUuidParam } from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  listUsersQuerySchema,
  updateUserSchema,
  uuidSchema,
} from "../schemas/authSchemas.js";
import { hashPassword, verifyPassword, burnPasswordCheck } from "../utils/password.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  getAccessTokenExpirySeconds,
  getRefreshTokenExpirySeconds,
} from "../utils/jwt.js";
import { REFRESH_COOKIE, cookieOptionsFromEnv, parseCookies, serializeRefreshCookie, clearRefreshCookie } from "../utils/cookies.js";
import { createLoginGuard } from "../utils/loginGuard.js";

const rateLimited = { error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later." } };

// Per-IP limits (the gateway sets X-Forwarded-For to the real client IP).
// Login/register are what credential-stuffing and enumeration scripts hammer.
const credentialLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: rateLimited });
// Phase 12: refresh/logout get their own, looser limit (one refresh per tab every ~15 minutes is normal).
const sessionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: rateLimited });

const invalidRefresh = (res, code = "INVALID_REFRESH_TOKEN") =>
  res.status(401).json({ error: { code, message: "Refresh token is invalid or expired." } });

export function createAuthRouter({ userRepository, refreshTokenRepository, audit = () => {}, loginGuard = createLoginGuard(), cookieOptions = cookieOptionsFromEnv() }) {
  const router = Router();

  const auditCtx = (req) => ({ ip: req.ip, requestId: req.headers["x-request-id"] || null });

  async function issueSession(req, res, user) {
    const publicUser = { id: user.id, email: user.email, role: user.role };
    const accessToken = signAccessToken(publicUser);
    const refreshToken = signRefreshToken(publicUser, randomUUID());
    const decoded = jwt.decode(refreshToken);
    await refreshTokenRepository.store({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(decoded.exp * 1000),
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });
    setRefreshCookie(res, refreshToken);
    return accessToken;
  }

  function setRefreshCookie(res, token) {
    res.append("Set-Cookie", serializeRefreshCookie(token, { maxAgeSeconds: getRefreshTokenExpirySeconds(), ...cookieOptions }));
  }

  // Cookie first (browsers); body as a fallback for non-browser clients.
  const presentedRefreshToken = (req) => parseCookies(req.headers.cookie)[REFRESH_COOKIE] || req.body?.refreshToken || null;

  // -----------------------------------------------------------------
  // POST /register — always creates a CITIZEN (Phase 12)
  // -----------------------------------------------------------------
  router.post("/register", credentialLimiter, validateBody(registerSchema), async (req, res, next) => {
    try {
      const { email, password, fullName } = req.body;
      const role = "CITIZEN";

      if (await userRepository.emailExists(email)) {
        audit({ action: "auth.register", outcome: "failure", ...auditCtx(req), details: { reason: "email already registered" } });
        return res.status(409).json({
          error: { code: "EMAIL_ALREADY_REGISTERED", message: "An account with this email already exists." },
        });
      }

      const passwordHash = await hashPassword(password);
      let user;
      try {
        user = await userRepository.create({ email, passwordHash, fullName, role });
      } catch (err) {
        // Two concurrent sign-ups with the same email both pass emailExists();
        // the UNIQUE index decides — answer the loser exactly like above.
        if (err && err.code === "23505") {
          return res.status(409).json({
            error: { code: "EMAIL_ALREADY_REGISTERED", message: "An account with this email already exists." },
          });
        }
        throw err;
      }
      audit({ action: "auth.register", outcome: "success", actor: { id: user.id, role, email: user.email }, ...auditCtx(req) });

      return res.status(201).json({
        user: { id: user.id, email: user.email, fullName: user.full_name, role, createdAt: user.created_at },
      });
    } catch (err) {
      next(err);
    }
  });

  // -----------------------------------------------------------------
  // POST /login
  // -----------------------------------------------------------------
  router.post("/login", credentialLimiter, validateBody(loginSchema), async (req, res, next) => {
    try {
      const { email, password } = req.body;

      // Phase 12: per-account lockout (in addition to the per-IP limit).
      if (loginGuard.isLocked(email)) {
        audit({ action: "auth.login", outcome: "denied", actor: { email }, ...auditCtx(req), details: { reason: "account temporarily locked" } });
        res.setHeader("Retry-After", String(loginGuard.retryAfterSeconds(email)));
        return res.status(429).json({ error: { code: "ACCOUNT_LOCKED", message: "Too many failed attempts for this account. Try again later." } });
      }

      const user = await userRepository.findByEmail(email);
      // Same status + message whether the email doesn't exist, the account
      // is inactive or the password is wrong — and (Phase 12) the same
      // TIME: an unknown email still runs a full bcrypt comparison.
      const passwordOk = user ? await verifyPassword(password, user.password_hash) : await burnPasswordCheck(password);

      if (!user || !user.is_active || !passwordOk) {
        loginGuard.recordFailure(email);
        audit({
          action: "auth.login",
          outcome: "failure",
          actor: user ? { id: user.id, role: user.role, email } : { email },
          ...auditCtx(req),
          details: { reason: !user ? "unknown email" : !user.is_active ? "account inactive" : "wrong password" },
        });
        return res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
      }

      loginGuard.recordSuccess(email);
      const accessToken = await issueSession(req, res, user);
      audit({ action: "auth.login", outcome: "success", actor: { id: user.id, role: user.role, email: user.email }, ...auditCtx(req) });

      // The refresh token is ONLY in the httpOnly cookie, never in the body.
      return res.status(200).json({
        accessToken,
        accessTokenExpiresIn: getAccessTokenExpirySeconds(),
        user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
      });
    } catch (err) {
      next(err);
    }
  });

  // -----------------------------------------------------------------
  // POST /refresh — rotates the refresh token on every use
  // -----------------------------------------------------------------
  router.post("/refresh", sessionLimiter, validateBody(refreshSchema), async (req, res, next) => {
    try {
      const refreshToken = presentedRefreshToken(req);
      if (!refreshToken) return invalidRefresh(res);

      let payload;
      try {
        payload = verifyRefreshToken(refreshToken);
        if (payload.type !== "refresh") throw new Error("wrong token type");
      } catch {
        res.append("Set-Cookie", clearRefreshCookie(cookieOptions));
        return invalidRefresh(res);
      }

      const oldTokenHash = hashToken(refreshToken);
      const stored = await refreshTokenRepository.findValid(oldTokenHash);
      if (!stored) {
        const row = await refreshTokenRepository.findByHash(oldTokenHash);
        if (row?.replaced_by_hash && row.recently_revoked) {
          // Two tabs refreshed at the same moment: the other one already
          // rotated this token and the browser now holds the new cookie.
          // Not an attack; the client simply retries once.
          return invalidRefresh(res, "REFRESH_TOKEN_ROTATED");
        }
        if (row?.replaced_by_hash) {
          // Phase 12: REUSE of an already-rotated token. Either the user or
          // an attacker holds a stolen copy — we can't tell which, so every
          // session of this account is ended.
          const revoked = await refreshTokenRepository.revokeAllForUser(row.user_id);
          audit({ action: "auth.refresh_reuse", outcome: "denied", actor: { id: row.user_id }, ...auditCtx(req), details: { sessionsRevoked: revoked } });
        }
        res.append("Set-Cookie", clearRefreshCookie(cookieOptions));
        return invalidRefresh(res);
      }

      const user = await userRepository.findById(payload.sub);
      if (!user || !user.is_active) {
        res.append("Set-Cookie", clearRefreshCookie(cookieOptions));
        return res.status(401).json({ error: { code: "INVALID_REFRESH_TOKEN", message: "Account is no longer active." } });
      }

      const publicUser = { id: user.id, email: user.email, role: user.role };
      const newAccessToken = signAccessToken(publicUser);
      const newRefreshToken = signRefreshToken(publicUser, randomUUID());
      const decoded = jwt.decode(newRefreshToken);

      const rotated = await refreshTokenRepository.rotate({
        oldTokenHash,
        newTokenHash: hashToken(newRefreshToken),
        userId: user.id,
        expiresAt: new Date(decoded.exp * 1000),
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });
      if (!rotated) return invalidRefresh(res, "REFRESH_TOKEN_ROTATED"); // lost a concurrent-refresh race

      setRefreshCookie(res, newRefreshToken);
      return res.status(200).json({ accessToken: newAccessToken, accessTokenExpiresIn: getAccessTokenExpirySeconds() });
    } catch (err) {
      next(err);
    }
  });

  // -----------------------------------------------------------------
  // POST /logout — revokes the presented refresh token (or all of them)
  // Phase 12: no access token needed (it may have expired); possession of
  // the refresh token is what proves the right to end that session.
  // -----------------------------------------------------------------
  router.post("/logout", sessionLimiter, validateBody(logoutSchema), async (req, res, next) => {
    try {
      const refreshToken = presentedRefreshToken(req);
      res.append("Set-Cookie", clearRefreshCookie(cookieOptions));
      if (!refreshToken) return res.status(204).send();

      let payload = null;
      try {
        payload = verifyRefreshToken(refreshToken);
      } catch {
        return res.status(204).send(); // already invalid: nothing to end
      }
      if (req.body.allDevices) {
        // Only a CURRENTLY valid session may end all the others — not an old,
        // already-rotated or revoked copy of a token.
        const stored = await refreshTokenRepository.findValid(hashToken(refreshToken));
        if (!stored) return res.status(204).send();
        await refreshTokenRepository.revokeAllForUser(stored.user_id);
      } else {
        await refreshTokenRepository.revoke(hashToken(refreshToken));
      }
      audit({ action: "auth.logout", outcome: "success", actor: { id: payload.sub }, ...auditCtx(req), details: { allDevices: Boolean(req.body.allDevices) } });
      // 204 either way: the end state the client cares about is reached.
      return res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // -----------------------------------------------------------------
  // GET /me — returns the authenticated user's own profile
  // -----------------------------------------------------------------
  router.get("/me", requireAuth, async (req, res, next) => {
    try {
      const user = await userRepository.findById(req.user.id);
      if (!user) {
        return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "User no longer exists." } });
      }
      return res.status(200).json({
        user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, createdAt: user.created_at },
      });
    } catch (err) {
      next(err);
    }
  });

  // -----------------------------------------------------------------
  // Phase 12: user management — SYSTEM_ADMIN only.
  // The only way to grant a privileged role now that sign-up is CITIZEN-only.
  // -----------------------------------------------------------------
  const toApiUser = (u) => ({ id: u.id, email: u.email, fullName: u.full_name, role: u.role, isActive: u.is_active, createdAt: u.created_at });

  router.get("/users", requireAuth, requireRole("SYSTEM_ADMIN"), validateQuery(listUsersQuerySchema), async (req, res, next) => {
    try {
      const { page, limit } = req.validatedQuery;
      const { users, total } = await userRepository.list({ page, limit });
      return res.status(200).json({ users: users.map(toApiUser), page, limit, total });
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    "/users/:id",
    requireAuth,
    requireRole("SYSTEM_ADMIN"),
    validateUuidParam("id", uuidSchema),
    validateBody(updateUserSchema),
    async (req, res, next) => {
      try {
        // Normalised: the same UUID in upper case must not dodge the self-check below.
        const id = req.params.id.toLowerCase();
        const { role, isActive } = req.body;
        const before = await userRepository.findById(id);
        if (!before) return res.status(404).json({ error: { code: "NOT_FOUND", message: "No such user." } });

        // An admin can't demote or deactivate themselves (no accidental lock-out),
        // and the last active SYSTEM_ADMIN can't be removed by anyone.
        const removesAdmin = before.role === "SYSTEM_ADMIN" && ((role && role !== "SYSTEM_ADMIN") || isActive === false);
        if (id === String(req.user.id).toLowerCase() && removesAdmin) {
          return res.status(400).json({ error: { code: "SELF_LOCKOUT", message: "You can't demote or deactivate your own admin account." } });
        }

        const result = await userRepository.updateGuarded(id, { role, isActive });
        if (result.error === "LAST_ADMIN") {
          return res.status(400).json({ error: { code: "LAST_ADMIN", message: "This is the last active SYSTEM_ADMIN." } });
        }
        const after = result.user;
        if (!after) return res.status(404).json({ error: { code: "NOT_FOUND", message: "No such user." } });
        // A role or status change ends the user's sessions: their next refresh
        // fails and they log in again with the new role. Existing access
        // tokens expire within 15 minutes.
        const changed = after.role !== before.role || after.is_active !== before.is_active;
        if (changed) await refreshTokenRepository.revokeAllForUser(id);
        audit({
          action: "user.update",
          outcome: "success",
          actor: { id: req.user.id, role: req.user.role },
          ...auditCtx(req),
          resource: { type: "user", id },
          details: { roleBefore: before.role, roleAfter: after.role, activeBefore: before.is_active, activeAfter: after.is_active },
        });
        return res.status(200).json({ user: toApiUser(after) });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
