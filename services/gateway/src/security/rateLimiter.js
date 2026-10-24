/**
 * Phase 12: small fixed-window rate limiter (no dependencies).
 *
 * Counts requests per key (client IP or user id) in fixed windows and
 * answers 429 with Retry-After once a key goes over its limit. State is
 * in memory, per gateway replica: with N replicas a client can make up to
 * N × limit requests per window. That's an accepted trade-off for this
 * project (documented in SECURITY.md); a shared store such as Redis is
 * the upgrade path if exact global limits are needed.
 */
export function createRateLimiter({
  name,
  windowMs,
  limit,
  keyFn,
  skip = () => false,
  onLimited = () => {},
  now = Date.now,
  maxKeys = 100_000,
}) {
  const windows = new Map(); // key -> { start, count }

  function sweep(t) {
    for (const [key, w] of windows) if (t - w.start >= windowMs) windows.delete(key);
  }

  function hit(key) {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      if (windows.size >= maxKeys) sweep(t);
      if (windows.size >= maxKeys) windows.clear(); // last resort: never grow without bound
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    w.count += 1;
    const resetMs = w.start + windowMs - t;
    return { allowed: w.count <= limit, remaining: Math.max(0, limit - w.count), resetMs };
  }

  function middleware(req, res, next) {
    if (skip(req)) return next();
    const key = keyFn(req);
    if (!key) return next();
    const { allowed, remaining, resetMs } = hit(key);
    const resetSec = Math.max(1, Math.ceil(resetMs / 1000));
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSec));
    if (allowed) return next();
    res.setHeader("Retry-After", String(resetSec));
    onLimited(req, { name, key, limit, windowMs });
    return res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down and try again shortly." } });
  }

  middleware.hit = hit; // exposed for tests
  middleware.size = () => windows.size;
  return middleware;
}
