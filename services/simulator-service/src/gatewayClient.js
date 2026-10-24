/**
 * Phase 16 — the simulator talks to SentinelCloud ONLY through the API
 * gateway, like a person in a browser (docs/PHASE-16-SIMULATOR.md §1):
 * same authentication, role checks, rate limits and audit log.
 *
 * - Logs in with its own service account and logs in again when the access
 *   token expires (a 401), once per request.
 * - Keeps its writes under the gateway's per-user limit (60/min): a sliding
 *   one-minute window, with scenario steps allowed up to SCENARIO_WRITE_CAP
 *   and background work only up to AMBIENT_WRITE_CAP, so a running scenario
 *   always has room.
 */
export const AMBIENT_WRITE_CAP = 40;
export const SCENARIO_WRITE_CAP = 55;
const WINDOW_MS = 60_000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Thrown when a background write is skipped to stay under the gateway's limit. */
export class BudgetExceeded extends Error {}

export function createGatewayClient({ baseUrl, email, password, fetchImpl = globalThis.fetch, now = Date.now, log = console }) {
  let token = null;
  const writes = []; // timestamps of writes in the last minute

  function writesInWindow() {
    const cutoff = now() - WINDOW_MS;
    while (writes.length && writes[0] <= cutoff) writes.shift();
    return writes.length;
  }

  async function login() {
    const res = await fetchImpl(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.accessToken) {
      throw new ApiError(res.status, body?.error?.code || "LOGIN_FAILED", `simulator login failed: ${body?.error?.message || res.status}`);
    }
    token = body.accessToken;
    log.log?.("[simulator-service] logged in to the gateway as the simulator service account");
  }

  /**
   * @param priority "scenario" (a scenario step) or "ambient" (background);
   *                 only writes (non-GET) count against the budget.
   */
  async function request(method, path, body, { priority = "scenario" } = {}) {
    const isWrite = method !== "GET";
    if (isWrite) {
      const cap = priority === "ambient" ? AMBIENT_WRITE_CAP : SCENARIO_WRITE_CAP;
      if (writesInWindow() >= cap) throw new BudgetExceeded(`write budget used up (${cap}/min for ${priority})`);
      writes.push(now());
    }
    if (!token) await login();
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && attempt === 1) {
        await login(); // expired access token: log in once more and retry
        continue;
      }
      const text = await res.text();
      const parsed = text ? safeJson(text) : null;
      if (!res.ok) {
        throw new ApiError(res.status, parsed?.error?.code || "HTTP_" + res.status, parsed?.error?.message || `${method} ${path} → ${res.status}`);
      }
      return parsed;
    }
  }

  return {
    request,
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body, opts) => request("POST", path, body ?? {}, opts),
    put: (path, body, opts) => request("PUT", path, body, opts),
    patch: (path, body, opts) => request("PATCH", path, body, opts),
    budget: () => ({ usedLastMinute: writesInWindow(), ambientCap: AMBIENT_WRITE_CAP, scenarioCap: SCENARIO_WRITE_CAP }),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
