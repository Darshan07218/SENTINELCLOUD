/**
 * Tiny HTTP client used for every in-cluster call except the Kubernetes
 * API: fault injection, whoami probes, load generation, the RabbitMQ
 * management API.
 *
 * Deliberately opens a NEW TCP connection per request (agent: false,
 * Connection: close). kube-proxy load-balances per CONNECTION, so with
 * keep-alive every probe would stick to one pod and the demo couldn't
 * show requests spreading across replicas (or leaving a failed one).
 *
 * Never throws: network errors resolve to { ok: false, status: 0, error }.
 */
import http from "node:http";

export function httpRequest(urlStr, { method = "GET", headers = {}, body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - started) / 1e6;
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      resolve({ ok: false, status: 0, error: `bad url: ${err.message}`, ms: 0, json: null });
      return;
    }
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        agent: false,
        timeout: timeoutMs,
        headers: {
          Connection: "close",
          ...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: data, ms: ms() });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", (err) => resolve({ ok: false, status: 0, error: err.code || err.message, ms: ms(), json: null }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
