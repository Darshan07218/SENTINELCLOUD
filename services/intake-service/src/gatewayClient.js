/**
 * Phase 19: intake-service creates disasters ONLY through the API gateway
 * (same as simulator-service, Phase 16), with its own service account
 * (INTAKE_EMAIL / INTAKE_PASSWORD, role EMERGENCY_OPERATOR): the same
 * authentication, role check, rate limit and audit log as an operator's
 * click, and the audit log names "Automatic Detection", never a person.
 * Logs in on first use and again once when the access token expires.
 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createGatewayClient({ baseUrl, email, password, fetchImpl = globalThis.fetch, log = console }) {
  let token = null;

  async function login() {
    const res = await fetchImpl(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.accessToken) {
      throw new ApiError(res.status, body?.error?.code || "LOGIN_FAILED", `intake login failed: ${body?.error?.message || res.status}`);
    }
    token = body.accessToken;
    log.log?.("[intake-service] logged in to the gateway as the intake service account");
  }

  async function request(method, path, body) {
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
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        throw new ApiError(res.status, parsed?.error?.code || `HTTP_${res.status}`, parsed?.error?.message || `${method} ${path} → ${res.status}`);
      }
      return parsed;
    }
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
  };
}
