/**
 * Engineering review: dashboards loaded their panels with Promise.all, so
 * ONE failing endpoint (a service restarting, a 403 on one list) blanked
 * every panel on the page. settle() runs the same requests with
 * Promise.allSettled and returns the values that arrived plus an error
 * message describing what didn't, so each panel keeps its last good data.
 *
 *   const { values, error } = await settle({ summary: p1, list: p2 });
 *   if (values.summary) setSummary(values.summary.summary);
 */
export async function settle(requests) {
  const names = Object.keys(requests);
  const results = await Promise.allSettled(names.map((n) => requests[n]));
  const values = {};
  const failures = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") values[names[i]] = r.value;
    else failures.push(r.reason?.message || String(r.reason));
  });
  const error =
    failures.length === 0
      ? null
      : failures.length === names.length
        ? failures[0]
        : `${failures.length} of ${names.length} data sources are unavailable (${failures[0]}) — showing what loaded.`;
  return { values, error };
}

/**
 * Returns a function that tags each request; `isLatest(tag)` is true only
 * for the most recent one. Guards against a slow, older response (e.g. the
 * previous page or the previously selected item) overwriting a newer one.
 */
export function latestOnly() {
  let seq = 0;
  return {
    next: () => ++seq,
    isLatest: (tag) => tag === seq,
  };
}
