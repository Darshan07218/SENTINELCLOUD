/**
 * Phase 10 — Prometheus metrics, with zero dependencies.
 *
 * Why hand-rolled instead of `prom-client`: the same reasoning as this
 * project's hand-rolled migration runner. The Prometheus text format is
 * simple (https://prometheus.io/docs/instrumenting/exposition_formats/),
 * and this file (mostly comments) is easier to read, review and explain in a
 * viva than a library's internals. It's also identical in every Node
 * service (copied, not shared, per the "no shared runtime code between
 * services" rule), so there's no extra dependency per service.
 *
 * The HTTP metric DELIBERATELY uses Spring Boot / Micrometer's name,
 * labels and buckets:
 *
 *   http_server_requests_seconds_bucket{method,uri,status,outcome,le}
 *
 * so ONE PromQL query covers all eight services (six Node, two Spring)
 * in every dashboard panel and alert, with no per-language special
 * cases. The buckets match `management.metrics.distribution.slo` in
 * the Spring services' application.yml, and `le` values are formatted
 * the way Micrometer formats them ("1.0", not "1"), so histograms from
 * both stacks aggregate correctly.
 *
 * Exposed at GET /metrics (Spring services: GET /prometheus).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

// Request-latency buckets (seconds) — keep identical to the Spring services' SLO list.
export const HTTP_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
// Event-processing buckets (seconds): publish → consumed is normally milliseconds,
// but a backed-up queue can push it to tens of seconds — that's what we want to see.
export const EVENT_LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

const DEPENDENCY_CHECK_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Text-format helpers
// ---------------------------------------------------------------------------

/** Formats a number the way Micrometer/Java does: integers keep ".0" (1 → "1.0"). */
export function formatNumber(n) {
  if (n === Infinity) return "+Inf";
  if (n === -Infinity) return "-Inf";
  if (Number.isNaN(n)) return "NaN";
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function renderLabels(pairs) {
  const parts = pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

function header(name, help, type) {
  return [`# HELP ${name} ${help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`, `# TYPE ${name} ${type}`];
}

// ---------------------------------------------------------------------------
// Metric types
// ---------------------------------------------------------------------------

class Metric {
  constructor(name, help, labelNames = []) {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`invalid metric name: ${name}`);
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.series = new Map(); // key → { labels: [[k, v]...], ... }
  }

  key(labels) {
    for (const k of Object.keys(labels)) {
      if (!this.labelNames.includes(k)) throw new Error(`${this.name}: unknown label "${k}"`);
    }
    return this.labelNames.map((n) => String(labels[n] ?? "")).join("\u0000");
  }

  pairs(labels) {
    return this.labelNames.map((n) => [n, String(labels[n] ?? "")]);
  }
}

export class Counter extends Metric {
  inc(labels = {}, value = 1) {
    if (value < 0) throw new Error(`${this.name}: counters can only increase`);
    const k = this.key(labels);
    const s = this.series.get(k) ?? { labels: this.pairs(labels), value: 0 };
    s.value += value;
    this.series.set(k, s);
  }

  async render() {
    const lines = header(this.name, this.help, "counter");
    for (const s of this.series.values()) lines.push(`${this.name}${renderLabels(s.labels)} ${formatNumber(s.value)}`);
    return lines;
  }
}

/**
 * A gauge either holds values set directly (`set`), or computes them at
 * scrape time via `collect: async () => [{ labels, value }]` — used for
 * process stats and dependency checks, which should reflect "now".
 */
export class Gauge extends Metric {
  constructor(name, help, labelNames = [], { collect } = {}) {
    super(name, help, labelNames);
    this.collect = collect;
  }

  set(labels = {}, value) {
    this.series.set(this.key(labels), { labels: this.pairs(labels), value });
  }

  async render() {
    const lines = header(this.name, this.help, "gauge");
    if (this.collect) {
      for (const { labels = {}, value } of await this.collect()) {
        lines.push(`${this.name}${renderLabels(this.pairs(labels))} ${formatNumber(value)}`);
      }
    } else {
      for (const s of this.series.values()) lines.push(`${this.name}${renderLabels(s.labels)} ${formatNumber(s.value)}`);
    }
    return lines;
  }
}

/** Monotonic counter whose value is read at scrape time (e.g. total CPU seconds). */
export class CollectedCounter extends Metric {
  constructor(name, help, collect) {
    super(name, help, []);
    this.collect = collect;
  }

  async render() {
    return [...header(this.name, this.help, "counter"), `${this.name} ${formatNumber(await this.collect())}`];
  }
}

export class Histogram extends Metric {
  constructor(name, help, labelNames = [], buckets = HTTP_LATENCY_BUCKETS) {
    super(name, help, labelNames);
    if (labelNames.includes("le")) throw new Error(`${name}: "le" is reserved for histogram buckets`);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels = {}, value) {
    if (!Number.isFinite(value)) return;
    const k = this.key(labels);
    const s = this.series.get(k) ?? { labels: this.pairs(labels), counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i] += 1; // stored cumulatively: each bucket counts every value ≤ its bound
    }
    s.sum += value;
    s.count += 1;
    this.series.set(k, s);
  }

  async render() {
    const lines = header(this.name, this.help, "histogram");
    for (const s of this.series.values()) {
      this.buckets.forEach((bound, i) => {
        lines.push(`${this.name}_bucket${renderLabels([...s.labels, ["le", formatNumber(bound)]])} ${s.counts[i]}`);
      });
      lines.push(`${this.name}_bucket${renderLabels([...s.labels, ["le", "+Inf"]])} ${s.count}`);
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${formatNumber(s.sum)}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class Registry {
  constructor() {
    this.metrics = new Map();
  }

  register(metric) {
    if (this.metrics.has(metric.name)) throw new Error(`metric already registered: ${metric.name}`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name, help, labelNames) { return this.register(new Counter(name, help, labelNames)); }
  gauge(name, help, labelNames, opts) { return this.register(new Gauge(name, help, labelNames, opts)); }
  histogram(name, help, labelNames, buckets) { return this.register(new Histogram(name, help, labelNames, buckets)); }

  /** Prometheus text exposition format 0.0.4. One failing collector never breaks the whole scrape. */
  async render() {
    const out = [];
    for (const metric of this.metrics.values()) {
      try {
        out.push(...(await metric.render()));
      } catch (err) {
        out.push(`# collector for ${metric.name} failed: ${String(err.message).replace(/\n/g, " ")}`);
      }
    }
    return out.join("\n") + "\n";
  }
}

// ---------------------------------------------------------------------------
// The SentinelCloud metrics every Node service exposes
// ---------------------------------------------------------------------------

export const registry = new Registry();

/** Same name/labels/buckets as Spring Boot's http.server.requests — see file header. */
export const httpRequestDuration = registry.histogram(
  "http_server_requests_seconds",
  "HTTP server request duration in seconds (Micrometer-compatible).",
  ["method", "uri", "status", "outcome"],
  HTTP_LATENCY_BUCKETS
);

/** End-to-end event latency: from the publisher's occurredAt timestamp until this consumer finished handling it. */
export const eventProcessingDuration = registry.histogram(
  "sentinel_event_processing_seconds",
  "Time from an event being published (envelope occurredAt) until this service finished processing it.",
  ["queue", "event_type", "outcome"],
  EVENT_LATENCY_BUCKETS
);

/** Just the handler's own run time, so queue waiting can be told apart from slow processing. */
export const eventHandlerDuration = registry.histogram(
  "sentinel_event_handler_seconds",
  "Time this service's handler spent processing one event.",
  ["queue", "event_type", "outcome"],
  EVENT_LATENCY_BUCKETS
);

export const eventsConsumed = registry.counter(
  "sentinel_events_consumed_total",
  "Events consumed from RabbitMQ, by queue, type and outcome (success | error | invalid).",
  ["queue", "event_type", "outcome"]
);

export const eventsPublished = registry.counter(
  "sentinel_events_published_total",
  "Events published to the sentinelcloud.events exchange, by type.",
  ["event_type"]
);

const dependencyChecks = new Map(); // name → async () => boolean

/** Resolves to the check's result, or false if it takes longer than `ms` (a hung DB must not hang the scrape). */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

registry.gauge(
  "sentinel_dependency_up",
  "1 if this service can currently reach the dependency (postgres, rabbitmq, redis), else 0.",
  ["dependency"],
  {
    collect: async () =>
      Promise.all(
        [...dependencyChecks].map(async ([dependency, check]) => {
          let ok = false;
          try {
            ok = Boolean(await withTimeout(Promise.resolve(check()), DEPENDENCY_CHECK_TIMEOUT_MS));
          } catch {
            ok = false;
          }
          return { labels: { dependency }, value: ok ? 1 : 0 };
        })
      ),
  }
);

/** e.g. registerDependencyCheck("postgres", async () => (await checkDbConnection()).connected) */
export function registerDependencyCheck(name, check) {
  dependencyChecks.set(name, check);
}

// ---- process / runtime metrics (prom-client-compatible names) ----

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

registry.register(
  new CollectedCounter("process_cpu_seconds_total", "Total user and system CPU time spent in seconds.", () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1e6;
  })
);
registry.gauge("process_resident_memory_bytes", "Resident memory size in bytes.", [], {
  collect: async () => [{ value: process.memoryUsage.rss() }],
});
registry.gauge("process_start_time_seconds", "Start time of the process since unix epoch in seconds.", [], {
  collect: async () => [{ value: Math.round(Date.now() / 1000 - process.uptime()) }],
});
registry.gauge("nodejs_heap_size_used_bytes", "V8 heap used in bytes.", [], {
  collect: async () => [{ value: process.memoryUsage().heapUsed }],
});
registry.gauge("nodejs_heap_size_total_bytes", "V8 heap allocated in bytes.", [], {
  collect: async () => [{ value: process.memoryUsage().heapTotal }],
});
// Event-loop delay since the previous scrape. High values mean the process
// is CPU-bound and EVERY request on it waits — a Node-specific early
// warning that shows up before latency alerts fire. Names match prom-client.
const toSeconds = (ns) => (Number.isFinite(ns) && ns > 0 && ns < 1e15 ? ns / 1e9 : 0);
let lagSnapshot = null; // one snapshot per scrape, shared by the three gauges below
function eventLoopLag() {
  if (!lagSnapshot) {
    lagSnapshot = {
      p50: toSeconds(eventLoopDelay.percentile(50)),
      p99: toSeconds(eventLoopDelay.percentile(99)),
      max: toSeconds(eventLoopDelay.max),
    };
    eventLoopDelay.reset();
    setImmediate(() => { lagSnapshot = null; });
  }
  return lagSnapshot;
}
registry.gauge("nodejs_eventloop_lag_p50_seconds", "Median event-loop delay since the previous scrape.", [], {
  collect: async () => [{ value: eventLoopLag().p50 }],
});
registry.gauge("nodejs_eventloop_lag_p99_seconds", "99th-percentile event-loop delay since the previous scrape.", [], {
  collect: async () => [{ value: eventLoopLag().p99 }],
});
registry.gauge("nodejs_eventloop_lag_max_seconds", "Maximum event-loop delay since the previous scrape.", [], {
  collect: async () => [{ value: eventLoopLag().max }],
});

// ---------------------------------------------------------------------------
// HTTP instrumentation
// ---------------------------------------------------------------------------

/** Micrometer's outcome tag. */
export function outcomeFor(status) {
  if (status < 200) return "INFORMATIONAL";
  if (status < 300) return "SUCCESS";
  if (status < 400) return "REDIRECTION";
  if (status < 500) return "CLIENT_ERROR";
  return "SERVER_ERROR";
}

/**
 * The route TEMPLATE, never the raw path — "/hospitals/:id", not
 * "/hospitals/42" — otherwise every id becomes its own time series
 * (unbounded cardinality, the classic way to take Prometheus down).
 * Requests that never matched a route (gateway proxy mounts, static
 * docs, 404s) are bucketed by their mount point.
 */
export function uriTemplate(req, res) {
  const base = req.baseUrl || "";
  if (req.route && req.route.path !== undefined) {
    const path = typeof req.route.path === "string" ? req.route.path : String(req.route.path);
    const full = `${base}${path}`;
    return full.length > 1 && full.endsWith("/") ? full.slice(0, -1) : full || "/";
  }
  if (base) return `${base}/**`;
  return res.statusCode === 404 ? "NOT_FOUND" : "UNMATCHED";
}

/** Register FIRST (before any route) so every request — including 401s from auth middleware — is timed. */
export function metricsMiddleware(req, res, next) {
  if (req.path === "/metrics") return next();
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe(
      { method: req.method, uri: uriTemplate(req, res), status: String(res.statusCode), outcome: outcomeFor(res.statusCode) },
      seconds
    );
  });
  next();
}

export async function metricsHandler(req, res) {
  try {
    const body = await registry.render();
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(body);
  } catch (err) {
    res.status(500).send(`# metrics collection failed: ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Event-bus instrumentation (called from broker.js)
// ---------------------------------------------------------------------------

/**
 * occurredAt is stamped by the PUBLISHING service's clock. Across pods
 * on one node (Kind/Minikube/Compose) clocks agree; across real nodes
 * NTP keeps skew to milliseconds. Negative values (skew) clamp to 0.
 */
export function recordEventConsumed({ queue, eventType, occurredAt, outcome, handlerSeconds }) {
  const labels = { queue, event_type: eventType || "unknown", outcome };
  eventsConsumed.inc(labels);
  if (Number.isFinite(handlerSeconds)) eventHandlerDuration.observe(labels, handlerSeconds);
  const publishedAtMs = Date.parse(occurredAt);
  if (Number.isFinite(publishedAtMs)) {
    eventProcessingDuration.observe(labels, Math.max(0, (Date.now() - publishedAtMs) / 1000));
  }
}

export function recordEventPublished(eventType) {
  eventsPublished.inc({ event_type: eventType });
}
