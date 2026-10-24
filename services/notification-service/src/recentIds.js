/**
 * Phase 14: remembers the last `capacity` event IDs this process has seen,
 * so the per-pod live feed doesn't push the same event to browsers twice
 * when it is redelivered (at-least-once delivery). Oldest IDs are forgotten
 * first; a Map keeps insertion order, so that's just its first key.
 */
export function createRecentIds(capacity = 1000) {
  const seen = new Map();
  return {
    /** True the first time an id is offered (and remembers it); false for a repeat. */
    firstTime(id) {
      if (id === undefined || id === null) return true; // nothing to compare: let it through
      const key = String(id);
      if (seen.has(key)) return false;
      seen.set(key, true);
      if (seen.size > capacity) seen.delete(seen.keys().next().value);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}
