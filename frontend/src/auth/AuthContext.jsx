import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { registerUser, loginUser, refreshTokens, logoutUser, fetchCurrentUser, ApiError } from "../lib/api.js";

// Phase 12: older builds kept the refresh token here; it is removed on load.
const LEGACY_REFRESH_TOKEN_STORAGE_KEY = "sentinelcloud.refreshToken";

const AuthContext = createContext(null);

/** Seconds until a JWT's `exp` (reads the payload; the signature is the server's business). */
function secondsUntilExpiry(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp - Date.now() / 1000;
  } catch {
    return -1;
  }
}

/**
 * Token storage strategy (Phase 12):
 *  - Access token: only in React state (memory), never persisted. Short-
 *    lived (15 min).
 *  - Refresh token: an httpOnly, SameSite=Strict cookie set by
 *    auth-service. JavaScript can't read it at all, so an XSS bug can't
 *    steal a long-lived session. The page just calls /auth/refresh and
 *    the browser attaches the cookie.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [loading, setLoading] = useState(true); // true while attempting silent refresh on first load
  const accessTokenRef = useRef(null); // avoids stale closures inside authFetch below
  accessTokenRef.current = accessToken;
  const refreshInFlight = useRef(null);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
  }, []);

  // One refresh at a time per tab. If another tab rotated the cookie at
  // the same moment, auth-service answers REFRESH_TOKEN_ROTATED and the
  // browser already holds the new cookie, so retry once.
  const refreshSession = useCallback(() => {
    if (!refreshInFlight.current) {
      refreshInFlight.current = (async () => {
        try {
          return await refreshTokens();
        } catch (err) {
          if (err instanceof ApiError && err.code === "REFRESH_TOKEN_ROTATED") {
            await new Promise((r) => setTimeout(r, 250));
            return refreshTokens();
          }
          throw err;
        }
      })()
        .then((session) => {
          accessTokenRef.current = session.accessToken;
          setAccessToken(session.accessToken);
          return session;
        })
        .finally(() => {
          refreshInFlight.current = null;
        });
    }
    return refreshInFlight.current;
  }, []);

  // On first load, try to turn the refresh cookie (if any) back into a
  // live session — "stay logged in across a page reload".
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_REFRESH_TOKEN_STORAGE_KEY);
    } catch {
      // storage may be unavailable (private mode); nothing to clean up then
    }
    (async () => {
      try {
        const session = await refreshSession();
        const me = await fetchCurrentUser(session.accessToken);
        setUser(me.user);
      } catch {
        clearSession();
      } finally {
        setLoading(false);
      }
    })();
  }, [clearSession, refreshSession]);

  const login = useCallback(async (email, password) => {
    const session = await loginUser({ email, password });
    accessTokenRef.current = session.accessToken;
    setAccessToken(session.accessToken);
    setUser(session.user);
    return session.user;
  }, []);

  const register = useCallback(async ({ email, password, fullName }) => {
    // Deliberately does not log the user in automatically: registration
    // and authentication are kept as distinct steps.
    return registerUser({ email, password, fullName });
  }, []);

  const logout = useCallback(
    async ({ allDevices = false } = {}) => {
      try {
        await logoutUser({ allDevices });
      } catch {
        // Even if the network call fails, local state is cleared below.
      } finally {
        clearSession();
      }
    },
    [clearSession]
  );

  /**
   * Fetch wrapper for any call that needs authentication. On a 401 it
   * attempts exactly one silent refresh-and-retry, never a loop.
   */
  const authFetch = useCallback(
    async (fn) => {
      try {
        return await fn(accessTokenRef.current);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          try {
            const session = await refreshSession();
            return await fn(session.accessToken);
          } catch (refreshErr) {
            clearSession();
            throw refreshErr;
          }
        }
        throw err;
      }
    },
    [clearSession, refreshSession]
  );

  /** A current access token (refreshed first if it expires within 30 s) — for the live WebSocket. */
  const getAccessToken = useCallback(async () => {
    const current = accessTokenRef.current;
    if (current && secondsUntilExpiry(current) > 30) return current;
    const session = await refreshSession();
    return session.accessToken;
  }, [refreshSession]);

  const value = useMemo(
    () => ({
      user,
      accessToken,
      isAuthenticated: Boolean(user && accessToken),
      loading,
      login,
      register,
      logout,
      authFetch,
      getAccessToken,
    }),
    [user, accessToken, loading, login, register, logout, authFetch, getAccessToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an <AuthProvider>");
  return ctx;
}
