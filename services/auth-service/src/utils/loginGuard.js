/**
 * Phase 12: per-ACCOUNT brute-force protection, on top of the per-IP
 * rate limit. An attacker spreading guesses across many IPs (a botnet,
 * or rotating proxies) still can't try more than `maxFailures` passwords
 * on one account per window.
 *
 * Counted by the email that was TRIED, whether or not such an account
 * exists, so the lockout itself can't be used to discover which emails
 * are registered. In memory, per auth-service replica (see SECURITY.md).
 */
export function createLoginGuard({ maxFailures = 10, windowMs = 15 * 60 * 1000, now = Date.now, maxKeys = 50_000 } = {}) {
  const failures = new Map(); // email -> { start, count }

  function entry(email) {
    const e = failures.get(email);
    if (e && now() - e.start >= windowMs) {
      failures.delete(email);
      return null;
    }
    return e || null;
  }

  return {
    /** True while the account has used up its failed attempts for this window. */
    isLocked(email) {
      const e = entry(email);
      return Boolean(e && e.count >= maxFailures);
    },
    recordFailure(email) {
      let e = entry(email);
      if (!e) {
        if (failures.size >= maxKeys) {
          for (const [k, v] of failures) if (now() - v.start >= windowMs) failures.delete(k);
          if (failures.size >= maxKeys) failures.clear();
        }
        e = { start: now(), count: 0 };
        failures.set(email, e);
      }
      e.count += 1;
      return e.count;
    },
    recordSuccess(email) {
      failures.delete(email);
    },
    retryAfterSeconds(email) {
      const e = entry(email);
      return e ? Math.max(1, Math.ceil((e.start + windowMs - now()) / 1000)) : 0;
    },
  };
}
