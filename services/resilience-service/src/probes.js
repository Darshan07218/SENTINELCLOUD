/**
 * Live observers used during a resilience drill. Each keeps compact
 * per-second buckets, so the Resilience Demo page can chart what
 * happened second by second:
 *
 *   RequestProbe   4 requests/s THROUGH the Kubernetes Service. Records
 *                  which pod answered each one → shows load balancing,
 *                  traffic leaving a failed pod, and traffic returning.
 *   LoadGenerator  N concurrent request streams of CPU-bound work → the
 *                  "high emergency traffic" that drives the HPA.
 *   BrokerDrill    producer (5/s) + consumer (10/s) on a dedicated drill
 *                  queue, with a local OUTBOX: events the producer can't
 *                  publish while the broker is down are buffered and
 *                  flushed on recovery, which is what makes the event
 *                  queue visibly build up and then drain.
 */
import { httpRequest } from "./http.js";

const nowSec = (now) => Math.floor(now() / 1000);

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

class SecondBuckets {
  constructor(make, { windowSec = 240, now = Date.now } = {}) {
    this.make = make;
    this.windowSec = windowSec;
    this.now = now;
    this.map = new Map();
  }

  current() {
    const t = nowSec(this.now);
    if (!this.map.has(t)) {
      this.map.set(t, { t, ...this.make() });
      for (const key of this.map.keys()) if (key < t - this.windowSec) this.map.delete(key);
    }
    return this.map.get(t);
  }

  all() {
    return [...this.map.values()].sort((a, b) => a.t - b.t);
  }
}

// ---------------------------------------------------------------------------

export class RequestProbe {
  constructor({ url, token, request = httpRequest, intervalMs = 250, timeoutMs = 1500, now = Date.now }) {
    Object.assign(this, { url, token, request, intervalMs, timeoutMs, now });
    this.buckets = new SecondBuckets(() => ({ ok: 0, failed: 0, byPod: {}, failedByPod: {}, latencies: [] }), { now });
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const r = await this.request(this.url, { headers: { "x-chaos-token": this.token }, timeoutMs: this.timeoutMs });
    const b = this.buckets.current();
    const pod = r.json?.pod || null;
    if (r.ok) {
      b.ok += 1;
      if (pod) b.byPod[pod] = (b.byPod[pod] || 0) + 1;
      b.latencies.push(r.ms);
    } else {
      b.failed += 1;
      const key = pod || (r.status === 0 ? `connection ${r.error || "error"}` : `HTTP ${r.status}`);
      b.failedByPod[key] = (b.failedByPod[key] || 0) + 1;
    }
  }

  series() {
    return this.buckets.all().map(({ latencies, ...rest }) => ({ ...rest, p95Ms: percentile(latencies, 95) }));
  }

  /** Totals for buckets whose second lies in [fromMs, toMs]. */
  totals(fromMs = 0, toMs = Infinity) {
    let ok = 0;
    let failed = 0;
    const byPod = {};
    for (const b of this.buckets.all()) {
      if (b.t * 1000 < fromMs - 999 || b.t * 1000 > toMs) continue;
      ok += b.ok;
      failed += b.failed;
      for (const [p, n] of Object.entries(b.byPod)) byPod[p] = (byPod[p] || 0) + n;
    }
    return { ok, failed, byPod };
  }
}

// ---------------------------------------------------------------------------

export class LoadGenerator {
  constructor({ url, token, concurrency = 8, request = httpRequest, timeoutMs = 5000, now = Date.now }) {
    Object.assign(this, { url, token, concurrency, request, timeoutMs, now });
    this.buckets = new SecondBuckets(() => ({ ok: 0, failed: 0, byPod: {}, latencies: [] }), { now });
    this.running = false;
    this.workers = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.concurrency; i++) this.workers.push(this.worker());
  }

  async stop() {
    this.running = false;
    await Promise.allSettled(this.workers);
    this.workers = [];
  }

  async worker() {
    while (this.running) {
      const r = await this.request(this.url, { headers: { "x-chaos-token": this.token }, timeoutMs: this.timeoutMs });
      const b = this.buckets.current();
      if (r.ok) {
        b.ok += 1;
        b.latencies.push(r.ms);
        const pod = r.json?.pod;
        if (pod) b.byPod[pod] = (b.byPod[pod] || 0) + 1;
      } else {
        b.failed += 1;
        await new Promise((res) => setTimeout(res, 50)); // don't spin on connection errors
      }
      // Always yield to the event loop between requests: if a response ever
      // resolves without real I/O, a tight await-loop would starve every timer
      // (the drill's own polling included).
      await new Promise((res) => setImmediate(res));
    }
  }

  series() {
    return this.buckets.all().map(({ latencies, ...rest }) => ({ ...rest, p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95) }));
  }

  /** p95 latency and throughput over the last `seconds` complete seconds. */
  recent(seconds = 5) {
    const t = nowSec(this.now);
    const recent = this.buckets.all().filter((b) => b.t < t && b.t >= t - seconds);
    const latencies = recent.flatMap((b) => b.latencies);
    const ok = recent.reduce((n, b) => n + b.ok, 0);
    return { p95Ms: percentile(latencies, 95), requestsPerSec: recent.length ? ok / recent.length : 0, failed: recent.reduce((n, b) => n + b.failed, 0) };
  }
}

// ---------------------------------------------------------------------------

export class BrokerDrill {
  constructor({ rabbit, produceEveryMs = 200, consumePerSec = 10, consumeEveryMs = 1000, now = Date.now }) {
    Object.assign(this, { rabbit, produceEveryMs, consumePerSec, consumeEveryMs, now });
    this.consumeBatch = Math.max(1, Math.round((consumePerSec * consumeEveryMs) / 1000));
    this.seq = 0;           // events created by the producer
    this.published = 0;     // accepted by the broker
    this.publishFailures = 0;
    this.consumed = 0;
    this.consumeFailures = 0;
    this.outbox = [];
    this.peakDepth = 0;
    this.peakOutbox = 0;
    this.consumerPaused = false;
    this.brokerDepth = null; // last broker-reported depth (management stats lag a few seconds)
    this.buckets = new SecondBuckets(() => ({ published: 0, consumed: 0, depth: 0, outbox: 0, brokerDepth: null }), { now });
    this.timers = [];
    this.producing = false;
  }

  start() {
    this.timers.push(setInterval(() => this.produceTick(), this.produceEveryMs));
    this.timers.push(setInterval(() => this.consumeTick(), this.consumeEveryMs));
    this.timers.push(setInterval(() => this.depthTick(), this.consumeEveryMs));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  pauseConsumer() { this.consumerPaused = true; }
  resumeConsumer() { this.consumerPaused = false; }

  get depth() {
    return Math.max(0, this.published - this.consumed);
  }

  /**
   * Depth that is normal between two consumer runs: events keep arriving
   * for one consume interval before the next batch takes them. A check
   * must not demand less, or it depends on WHEN it samples (a 1s poll
   * phase-locked to a 1s consumer sees the peak every time).
   */
  get steadyStateDepth() {
    return Math.ceil(this.consumeEveryMs / this.produceEveryMs) + 1;
  }

  /** Backlog gone: consumer running, at most the one event in flight in the outbox, depth back to steady state. */
  isDrained() {
    return !this.consumerPaused && this.outbox.length <= 1 && this.depth <= this.steadyStateDepth;
  }

  async produceTick() {
    this.seq += 1;
    this.outbox.push({ seq: this.seq, createdAt: new Date(this.now()).toISOString(), kind: "resilience-drill" });
    if (this.producing) return; // previous flush still running — the new event waits in the outbox
    this.producing = true;
    try {
      let flushed = 0;
      while (this.outbox.length > 0 && flushed < 50) {
        const ok = await this.rabbit.publishDrill(this.outbox[0]);
        if (!ok) {
          this.publishFailures += 1;
          break;
        }
        this.outbox.shift();
        this.published += 1;
        flushed += 1;
        this.buckets.current().published += 1;
      }
    } finally {
      this.producing = false;
      this.record();
    }
  }

  async consumeTick() {
    if (this.consumerPaused) return this.record();
    const n = await this.rabbit.consumeDrill(this.consumeBatch);
    if (n === null) this.consumeFailures += 1;
    else {
      this.consumed += n;
      this.buckets.current().consumed += n;
    }
    return this.record();
  }

  async depthTick() {
    const d = await this.rabbit.drillQueueDepth();
    this.brokerDepth = d ? d.messages : null;
    this.buckets.current().brokerDepth = this.brokerDepth;
  }

  record() {
    this.peakDepth = Math.max(this.peakDepth, this.depth);
    this.peakOutbox = Math.max(this.peakOutbox, this.outbox.length);
    const b = this.buckets.current();
    b.depth = this.depth;
    b.outbox = this.outbox.length;
  }

  snapshot() {
    return {
      produced: this.seq,
      published: this.published,
      publishFailures: this.publishFailures,
      consumed: this.consumed,
      depth: this.depth,
      brokerDepth: this.brokerDepth,
      outbox: this.outbox.length,
      peakDepth: this.peakDepth,
      peakOutbox: this.peakOutbox,
      consumerPaused: this.consumerPaused,
    };
  }

  series() {
    return this.buckets.all();
  }
}
