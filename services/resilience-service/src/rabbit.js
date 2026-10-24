/**
 * RabbitMQ management-API client (HTTP, zero dependencies) for the
 * broker-failure drill.
 *
 * The drill uses its OWN direct exchange + durable queue, so drill
 * messages never reach the domain event bus: notification-service binds
 * "#" on sentinelcloud.events and would otherwise broadcast them to
 * every live dashboard.
 */
import { httpRequest } from "./http.js";

export const DRILL_EXCHANGE = "sentinelcloud.resilience";
export const DRILL_QUEUE = "q.resilience.drill";
export const DRILL_ROUTING_KEY = "drill";

export function createRabbitAdmin({ baseUrl, user, password, request = httpRequest, timeoutMs = 2000 }) {
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const vhost = encodeURIComponent("/");
  const call = (method, path, body) =>
    request(`${baseUrl}/api${path}`, { method, body, timeoutMs, headers: { Authorization: auth } });

  return {
    /** Idempotent: durable exchange + durable queue + binding. */
    async ensureDrillTopology() {
      const steps = [
        await call("PUT", `/exchanges/${vhost}/${encodeURIComponent(DRILL_EXCHANGE)}`, { type: "direct", durable: true, auto_delete: false }),
        await call("PUT", `/queues/${vhost}/${encodeURIComponent(DRILL_QUEUE)}`, { durable: true, auto_delete: false }),
        await call("POST", `/bindings/${vhost}/e/${encodeURIComponent(DRILL_EXCHANGE)}/q/${encodeURIComponent(DRILL_QUEUE)}`, { routing_key: DRILL_ROUTING_KEY }),
      ];
      const failed = steps.find((s) => !s.ok);
      if (failed) throw new Error(`RabbitMQ management API: ${failed.status || failed.error} ${failed.text || ""}`.trim());
    },

    async purgeDrillQueue() {
      return call("DELETE", `/queues/${vhost}/${encodeURIComponent(DRILL_QUEUE)}/contents`);
    },

    /** delivery_mode 2 = persistent: survives a broker restart in the durable queue. */
    async publishDrill(event) {
      const r = await call("POST", `/exchanges/${vhost}/${encodeURIComponent(DRILL_EXCHANGE)}/publish`, {
        properties: { delivery_mode: 2, content_type: "application/json" },
        routing_key: DRILL_ROUTING_KEY,
        payload: JSON.stringify(event),
        payload_encoding: "string",
      });
      return r.ok && r.json?.routed === true;
    },

    /** Consume (and ack) up to `count` messages. Returns the number consumed, or null if the broker is unreachable. */
    async consumeDrill(count) {
      const r = await call("POST", `/queues/${vhost}/${encodeURIComponent(DRILL_QUEUE)}/get`, {
        count,
        ackmode: "ack_requeue_false",
        encoding: "auto",
      });
      if (!r.ok) return null;
      return Array.isArray(r.json) ? r.json.length : 0;
    },

    /** Broker-reported depth (the management stats refresh every few seconds). null = unreachable. */
    async drillQueueDepth() {
      const r = await call("GET", `/queues/${vhost}/${encodeURIComponent(DRILL_QUEUE)}`);
      if (!r.ok) return null;
      return { messages: r.json?.messages ?? 0, ready: r.json?.messages_ready ?? 0, unacked: r.json?.messages_unacknowledged ?? 0, durable: r.json?.durable ?? null };
    },

    async reachable() {
      const r = await call("GET", "/overview");
      return r.ok;
    },
  };
}
