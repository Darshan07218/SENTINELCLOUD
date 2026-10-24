/**
 * The six Resilience Demo scenarios (Phase 11).
 *
 * All faults are SOFTWARE faults inside SentinelCloud's own services
 * (see services/<name>/src/chaos.js and the Spring ChaosController), or
 * deletion of one of SentinelCloud's own pods. No real infrastructure
 * is simulated or touched. What the demo shows is how the platform's
 * cloud-native design responds:
 *
 *   1 hospital-failure    one pod hangs        → readiness probe pulls it from load balancing,
 *                                               liveness probe gets it restarted
 *   2 ambulance-failure   one process crashes  → kubelet restarts the container
 *   3 blood-failure       Spring liveness BROKEN (Java) → probe-driven restart
 *   4 power-failure       one pod deleted      → ReplicaSet creates a replacement (replica recovery)
 *   5 traffic-surge       CPU-heavy load       → HPA scales out, Service spreads the load
 *   6 broker-failure      RabbitMQ pod killed  → events buffered, queue builds up, StatefulSet
 *                                               recreates the broker on its volume, backlog drains
 *
 * Each scenario: run(ctx) drives the stages; observe(ctx) produces the
 * live view (polled every second); cleanup(ctx) always runs.
 */
import { summarizePod, summarizeEndpoints, summarizeHpa, summarizeEvents } from "./k8s.js";
import { waitFor } from "./runner.js";
import { RequestProbe, LoadGenerator, BrokerDrill } from "./probes.js";

export const TARGETS = Object.freeze({
  "hospital-service": { port: 8082 },
  "ambulance-service": { port: 8083 },
  "blood-bank-service": { port: 8084 },
  "power-service": { port: 8085 },
});

const BROKER_POD = "rabbitmq-0";
const BROKER_CONNECTIVITY_PROBES = [
  // Node services report the broker in /health/ready ("connected" / "disconnected (...)").
  { service: "gateway", port: 8080 },
  { service: "hospital-service", port: 8082 },
  { service: "ambulance-service", port: 8083 },
  { service: "disaster-service", port: 8086 },
  { service: "notification-service", port: 8087 },
];

const secs = (ms) => Math.round(ms / 100) / 10;
const serviceUrl = (ctx, service, port) => `http://${service}${ctx.cfg.serviceDomain || ""}:${port}`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export async function targetPods(ctx, service) {
  const pods = await ctx.k8s.listPods(`app.kubernetes.io/name=${service}`);
  return pods.map((p) => summarizePod(p, service)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function targetEndpoints(ctx, service) {
  return summarizeEndpoints(await ctx.k8s.listEndpointSlices(service));
}

async function podNow(ctx, name, container) {
  const pod = await ctx.k8s.getPod(name);
  return pod ? summarizePod(pod, container) : null;
}

async function latestEvent(ctx, objectName, reasons) {
  try {
    const events = summarizeEvents(await ctx.k8s.listEvents(objectName));
    return events.find((e) => reasons.includes(e.reason)) || null;
  } catch {
    return null;
  }
}

function eventEvidence(ev) {
  return ev ? `Kubernetes event (${ev.source || "cluster"}): ${ev.reason}: ${ev.message}` : null;
}

async function observeTarget(ctx, service) {
  const [pods, endpoints, hpa] = await Promise.all([
    targetPods(ctx, service),
    targetEndpoints(ctx, service),
    ctx.k8s.getHpa(service).then(summarizeHpa).catch(() => null),
  ]);
  return { service, pods, endpoints, readyEndpoints: endpoints.filter((e) => e.ready).length, hpa };
}

/**
 * The HPA owns each Deployment's replica count (Phase 9), so to get N
 * replicas for a load-balancing demo we raise the HPA's minReplicas,
 * never the Deployment directly. The original value is restored in cleanup.
 */
async function ensureReplicas(ctx, service, n) {
  const { run, k8s, cfg } = ctx;
  const hpa = await k8s.getHpa(service);
  const min = hpa?.spec?.minReplicas ?? 1;
  if (hpa && min < n) {
    ctx.state.hpaRestore = { name: service, minReplicas: min };
    await k8s.patchHpa(service, { spec: { minReplicas: n } });
    run.log(`Raised ${service} HPA minReplicas ${min} → ${n} so there is a healthy replica to fail over to (restored afterwards).`, { source: "resilience-service" });
  }
  const ready = await waitFor(
    ctx,
    `${n} ready ${service} replicas`,
    async () => {
      const [pods, eps] = await Promise.all([targetPods(ctx, service), targetEndpoints(ctx, service)]);
      const readyPods = pods.filter((p) => p.ready && p.state === "ready");
      return readyPods.length >= n && eps.filter((e) => e.ready).length >= n ? readyPods : null;
    },
    { timeoutMs: cfg.prepareTimeoutMs }
  );
  run.log(`${ready.length} ${service} replicas ready: ${ready.map((p) => p.name).join(", ")}`, { source: "kubernetes" });
  return ready;
}

async function restoreHpa(ctx) {
  const r = ctx.state.hpaRestore;
  if (!r) return;
  await ctx.k8s.patchHpa(r.name, { spec: { minReplicas: r.minReplicas } });
  ctx.run.log(`Restored ${r.name} HPA minReplicas to ${r.minReplicas}. The extra replica is removed by the HPA's normal scale-down (~2-3 min).`);
  ctx.state.hpaRestore = null;
}

async function injectFault(ctx, pod, port, mode) {
  return ctx.request(`http://${pod.ip}:${port}/internal/chaos?mode=${mode}`, {
    method: "POST",
    headers: { "x-chaos-token": ctx.cfg.chaosToken },
    timeoutMs: 3000,
  });
}

async function clearFaults(ctx, service, port) {
  let pods = [];
  try {
    pods = await targetPods(ctx, service);
  } catch {
    return;
  }
  await Promise.all(pods.filter((p) => p.ip).map((p) => injectFault(ctx, p, port, "clear")));
}

function startProbe(ctx, service, port) {
  const probe = new RequestProbe({
    url: `${serviceUrl(ctx, service, port)}/internal/whoami`,
    token: ctx.cfg.chaosToken,
    request: ctx.request,
    intervalMs: ctx.cfg.probeIntervalMs,
  });
  probe.start();
  ctx.state.probe = probe;
  return probe;
}

function incidentSummary(ctx, extra = {}) {
  const { run, state } = ctx;
  const tFail = run.stageTime("FAILURE");
  const tDetect = run.stageTime("DETECTION");
  const tRecover = run.stageTime("RECOVERY");
  const tRestored = run.stageTime("RESTORED");
  const summary = {
    timeToDetectSec: tFail && tDetect ? secs(tDetect - tFail) : null,
    timeToRecoverySec: tFail && tRecover ? secs(tRecover - tFail) : null,
    timeToRestoreSec: tFail && tRestored ? secs(tRestored - tFail) : null,
    ...extra,
  };
  if (state.probe && tFail && tRestored) {
    const t = state.probe.totals(tFail, tRestored);
    const total = t.ok + t.failed;
    summary.requestsDuringIncident = { ok: t.ok, failed: t.failed, servedBy: t.byPod };
    summary.successRatePercent = total ? Math.round((t.ok / total) * 1000) / 10 : null;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Scenarios 1–3: a fault inside one pod (hang or crash)
// ---------------------------------------------------------------------------

function podFaultScenario({ id, title, service, mode, description, failureText, bannerText, demonstrates, mechanism, estimatedSeconds }) {
  const { port } = TARGETS[service];
  const isCrash = mode === "crash";

  return {
    id, title, target: service, description, demonstrates, mechanism, estimatedSeconds,

    async run(ctx) {
      const { run, cfg } = ctx;
      run.setStage("NORMAL", {
        summary: `Normal state: ${service} running with ${cfg.replicas} replicas behind its Kubernetes Service.`,
        banner: { level: "normal", headline: "NORMAL STATE", detail: `${service}: preparing ${cfg.replicas} healthy replicas` },
      });
      await ensureReplicas(ctx, service, cfg.replicas);
      startProbe(ctx, service, port);
      run.log(`Sending ${Math.round(1000 / cfg.probeIntervalMs)} requests/s to ${service} through its Service (a new connection each time); kube-proxy spreads them across the replicas.`);
      run.banner = { level: "normal", headline: "NORMAL STATE", detail: `${cfg.replicas}/${cfg.replicas} ${service} replicas healthy and sharing traffic` };
      await ctx.sleep(cfg.normalMs);

      const victim = (await targetPods(ctx, service)).find((p) => p.ready && p.state === "ready");
      if (!victim) throw new Error(`no ready ${service} pod to fail`);
      ctx.state.victim = victim.name;
      const baseline = victim.restarts;

      const injected = await injectFault(ctx, victim, port, mode);
      if (!injected.ok && !(isCrash && injected.status === 0)) {
        throw new Error(`fault injection into ${victim.name} failed (HTTP ${injected.status || injected.error}). Is CHAOS_ENABLED=true and CHAOS_TOKEN set on ${service}?`);
      }
      run.setStage("FAILURE", {
        summary: `Injected fault: ${service} pod ${victim.name} ${failureText}`,
        banner: { level: "failed", headline: "SERVICE FAILED", detail: `${service}: pod ${victim.name} ${bannerText}` },
      });

      // DETECTION: Kubernetes notices (pod NotReady, or the container already exited/restarted).
      const detected = await waitFor(
        ctx,
        "Kubernetes to detect the failed pod",
        async () => {
          const p = await podNow(ctx, victim.name, service);
          return p && (!p.ready || p.restarts > baseline) ? p : null;
        },
        { timeoutMs: cfg.detectTimeoutMs }
      );
      const detectEvent = await latestEvent(ctx, victim.name, ["Unhealthy", "BackOff"]);
      const detection = isCrash
        ? `kubelet saw the container exit${detected.lastTermination ? ` (exit code ${detected.lastTermination.exitCode}, ${detected.lastTermination.reason})` : ""} and marked ${victim.name} NotReady; it was removed from the ${service} Service endpoints, so requests now go only to the healthy replica.`
        : `Readiness probe failed (HTTP 503) → Kubernetes marked ${victim.name} NotReady and removed it from the ${service} Service endpoints. Requests now go only to the healthy replica.`;
      run.setStage("DETECTION", {
        summary: detection,
        evidence: eventEvidence(detectEvent) || (detected.lastTermination ? `Container last terminated: ${detected.lastTermination.reason}, exit code ${detected.lastTermination.exitCode}` : null),
        banner: { level: "detecting", headline: "FAILURE DETECTED", detail: isCrash ? "container exit detected · pod removed from load balancing" : "health checks failing · pod removed from load balancing" },
      });

      // RECOVERY: the container has been restarted and is running again.
      const restarted = await waitFor(
        ctx,
        `kubelet to restart the ${service} container`,
        async () => {
          const p = await podNow(ctx, victim.name, service);
          return p && p.restarts > baseline && (p.state === "running-not-ready" || p.state === "ready") ? p : null;
        },
        { timeoutMs: cfg.recoverTimeoutMs }
      );
      const recoverEvent = await latestEvent(ctx, victim.name, ["Killing", "Started"]);
      run.setStage("RECOVERY", {
        summary: isCrash
          ? `kubelet restarted the crashed container automatically (restartPolicy: Always): restart #${restarted.restarts}. The new process starts clean; its startup and readiness probes now decide when it rejoins.`
          : `Liveness probe failed 3× → kubelet killed and restarted the container (restart #${restarted.restarts}). The new process starts clean (the fault lived only in memory); startup and readiness probes now decide when it rejoins.`,
        evidence: eventEvidence(recoverEvent),
        banner: { level: "recovering", headline: "SELF-HEALING", detail: `container restarted (restart #${restarted.restarts}) · waiting for readiness probe` },
      });

      // RESTORED: back in the load balancer, all replicas serving.
      const restored = await waitFor(
        ctx,
        `${victim.name} to pass its readiness probe and rejoin the Service`,
        async () => {
          const [p, eps] = await Promise.all([podNow(ctx, victim.name, service), targetEndpoints(ctx, service)]);
          const readyEps = eps.filter((e) => e.ready).length;
          return p?.ready && eps.some((e) => e.pod === victim.name && e.ready) && readyEps >= cfg.replicas ? { readyEps } : null;
        },
        { timeoutMs: cfg.restoreTimeoutMs }
      );
      run.setStage("RESTORED", {
        summary: `${victim.name} passed its readiness probe and is back in the load balancer: ${restored.readyEps}/${cfg.replicas} replicas serving. Nobody intervened manually.`,
        banner: { level: "restored", headline: "SERVICE RESTORED", detail: `${restored.readyEps}/${cfg.replicas} replicas healthy · traffic balanced again` },
      });
      await ctx.sleep(cfg.holdMs);
      run.summary = incidentSummary(ctx, { failedPod: victim.name, restarts: restarted.restarts - baseline });
    },

    async observe(ctx) {
      return { kind: "pods", target: await observeTarget(ctx, service), victim: ctx.state.victim || null, traffic: ctx.state.probe?.series() || [] };
    },

    async cleanup(ctx) {
      ctx.state.probe?.stop();
      await clearFaults(ctx, service, port);
      await restoreHpa(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 4: pod loss → ReplicaSet replacement
// ---------------------------------------------------------------------------

function podLossScenario({ id, title, service, description, demonstrates, mechanism, estimatedSeconds }) {
  const { port } = TARGETS[service];
  return {
    id, title, target: service, description, demonstrates, mechanism, estimatedSeconds,

    async run(ctx) {
      const { run, cfg, k8s } = ctx;
      run.setStage("NORMAL", {
        summary: `Normal state: ${service} running with ${cfg.replicas} replicas (a Deployment → ReplicaSet keeps that count).`,
        banner: { level: "normal", headline: "NORMAL STATE", detail: `${service}: preparing ${cfg.replicas} healthy replicas` },
      });
      const before = await ensureReplicas(ctx, service, cfg.replicas);
      startProbe(ctx, service, port);
      run.banner = { level: "normal", headline: "NORMAL STATE", detail: `${cfg.replicas}/${cfg.replicas} ${service} replicas healthy and sharing traffic` };
      await ctx.sleep(cfg.normalMs);

      const known = new Set((await targetPods(ctx, service)).map((p) => p.name));
      const victim = before[0];
      ctx.state.victim = victim.name;
      await k8s.deletePod(victim.name);
      run.setStage("FAILURE", {
        summary: `Pod ${victim.name} was lost (deleted, the same as a crashed node or an evicted pod). One of ${cfg.replicas} replicas is gone.`,
        banner: { level: "failed", headline: "SERVICE FAILED", detail: `${service}: pod ${victim.name} lost` },
      });

      await waitFor(
        ctx,
        `${victim.name} to leave the Service endpoints`,
        async () => {
          const eps = await targetEndpoints(ctx, service);
          return !eps.some((e) => e.pod === victim.name && e.ready && !e.terminating);
        },
        { timeoutMs: cfg.detectTimeoutMs }
      );
      run.setStage("DETECTION", {
        summary: `The endpoint controller removed ${victim.name} from the ${service} Service immediately (it's terminating), and the ReplicaSet controller now sees ${cfg.replicas - 1}/${cfg.replicas} replicas, below its desired count.`,
        banner: { level: "detecting", headline: "FAILURE DETECTED", detail: `ReplicaSet below desired count (${cfg.replicas - 1}/${cfg.replicas}) · traffic on the remaining replica` },
      });

      const replacement = await waitFor(
        ctx,
        "the ReplicaSet to create a replacement pod",
        async () => (await targetPods(ctx, service)).find((p) => !known.has(p.name)) || null,
        { timeoutMs: cfg.recoverTimeoutMs }
      );
      ctx.state.replacement = replacement.name;
      const scheduled = await latestEvent(ctx, replacement.name, ["Scheduled", "Started", "Pulled", "Created"]);
      run.setStage("RECOVERY", {
        summary: `The ReplicaSet controller created a replacement pod, ${replacement.name}${replacement.node ? ` (scheduled on node ${replacement.node})` : ""}. It's starting up; its startup and readiness probes decide when it may take traffic.`,
        evidence: eventEvidence(scheduled),
        banner: { level: "recovering", headline: "SELF-HEALING", detail: `replacement pod ${replacement.name} starting` },
      });

      const restored = await waitFor(
        ctx,
        `replacement pod ${replacement.name} to become ready`,
        async () => {
          const [p, eps] = await Promise.all([podNow(ctx, replacement.name, service), targetEndpoints(ctx, service)]);
          const readyEps = eps.filter((e) => e.ready && !e.terminating).length;
          return p?.ready && readyEps >= cfg.replicas ? { readyEps } : null;
        },
        { timeoutMs: cfg.restoreTimeoutMs }
      );
      run.setStage("RESTORED", {
        summary: `${replacement.name} is ready and in the load balancer: ${restored.readyEps}/${cfg.replicas} replicas again. The lost pod was replaced, not repaired.`,
        banner: { level: "restored", headline: "SERVICE RESTORED", detail: `${restored.readyEps}/${cfg.replicas} replicas (new pod ${replacement.name})` },
      });
      await ctx.sleep(cfg.holdMs);
      run.summary = incidentSummary(ctx, { lostPod: victim.name, replacementPod: replacement.name });
    },

    async observe(ctx) {
      return {
        kind: "pods",
        target: await observeTarget(ctx, service),
        victim: ctx.state.victim || null,
        replacement: ctx.state.replacement || null,
        traffic: ctx.state.probe?.series() || [],
      };
    },

    async cleanup(ctx) {
      ctx.state.probe?.stop();
      await restoreHpa(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 5: high emergency traffic → horizontal scaling
// ---------------------------------------------------------------------------

function trafficSurgeScenario({ id, title, service, description, demonstrates, mechanism, estimatedSeconds }) {
  const { port } = TARGETS[service];
  return {
    id, title, target: service, description, demonstrates, mechanism, estimatedSeconds,

    async run(ctx) {
      const { run, cfg, k8s } = ctx;
      const hpa = summarizeHpa(await k8s.getHpa(service));
      if (!hpa) throw new Error(`${service} has no HorizontalPodAutoscaler`);
      const baselinePods = (await targetPods(ctx, service)).filter((p) => p.ready);
      const baseline = baselinePods.length;
      ctx.state.baseline = baseline;
      run.setStage("NORMAL", {
        summary: `Normal load: ${baseline} ${service} replica(s); the HPA keeps ${hpa.minReplicas}-${hpa.maxReplicas} replicas and targets ${hpa.targetCpuPercent}% CPU (current: ${hpa.cpuPercent ?? "n/a"}%).`,
        banner: { level: "normal", headline: "NORMAL STATE", detail: `${baseline} replica(s) · CPU ${hpa.cpuPercent ?? "n/a"}% of request` },
      });
      startProbe(ctx, service, port);
      await ctx.sleep(cfg.normalMs);

      const load = new LoadGenerator({
        url: `${serviceUrl(ctx, service, port)}/internal/work?ms=${cfg.load.workMs}`,
        token: cfg.chaosToken,
        concurrency: cfg.load.concurrency,
        request: ctx.request,
      });
      ctx.state.load = load;
      load.start();
      await ctx.sleep(Math.min(3000, cfg.normalMs));
      const surge = load.recent(3);
      ctx.state.surgeP95 = surge.p95Ms;
      ctx.state.surgeRps = surge.requestsPerSec;
      run.setStage("FAILURE", {
        summary: `Emergency traffic surge: ${cfg.load.concurrency} concurrent request streams of CPU-heavy work (${cfg.load.workMs}ms each) hit ${service}. ${baseline} replica(s) can't keep up: p95 latency ${surge.p95Ms ? Math.round(surge.p95Ms) + "ms" : "rising"}.`,
        banner: { level: "failed", headline: "SERVICE OVERLOADED", detail: `${service} · ${cfg.load.concurrency}× surge on ${baseline} replica(s) · p95 ${surge.p95Ms ? Math.round(surge.p95Ms) + "ms" : "…"}` },
      });

      const detected = await waitFor(
        ctx,
        "the HPA to react to CPU load (is metrics-server installed?)",
        async () => {
          const h = summarizeHpa(await k8s.getHpa(service));
          return h && h.desiredReplicas > baseline ? h : null;
        },
        { timeoutMs: cfg.detectTimeoutMs }
      );
      run.setStage("DETECTION", {
        summary: `The HorizontalPodAutoscaler measured CPU at ${detected.cpuPercent ?? "?"}% of the pods' request (target ${detected.targetCpuPercent}%) and decided ${service} needs ${detected.desiredReplicas} replicas.`,
        evidence: eventEvidence(await latestEvent(ctx, service, ["SuccessfulRescale"])),
        banner: { level: "detecting", headline: "OVERLOAD DETECTED", detail: `HPA: CPU ${detected.cpuPercent ?? "?"}% > ${detected.targetCpuPercent}% target → scale to ${detected.desiredReplicas}` },
      });

      const scaled = await waitFor(
        ctx,
        "new replicas to become ready",
        async () => {
          const ready = (await targetPods(ctx, service)).filter((p) => p.ready);
          return ready.length > baseline ? ready : null;
        },
        { timeoutMs: cfg.recoverTimeoutMs }
      );
      run.setStage("RECOVERY", {
        summary: `Scaling out: ${scaled.length} replicas now ready (${scaled.filter((p) => !baselinePods.some((b) => b.name === p.name)).map((p) => p.name).join(", ")} new). The Service is already spreading the surge across them.`,
        banner: { level: "recovering", headline: "SCALING OUT", detail: `${scaled.length} replicas ready · load spreading across pods` },
      });

      // RESTORED: capacity matches what the HPA asked for, stable for two consecutive checks.
      let stableChecks = 0;
      const settled = await waitFor(
        ctx,
        "the scale-out to settle",
        async () => {
          const [h, pods] = await Promise.all([k8s.getHpa(service).then(summarizeHpa), targetPods(ctx, service)]);
          const ready = pods.filter((p) => p.ready).length;
          const want = Math.min(h.desiredReplicas, h.maxReplicas ?? h.desiredReplicas);
          stableChecks = ready >= want && ready > baseline ? stableChecks + 1 : 0;
          return stableChecks >= 2 ? { ready, h } : null;
        },
        { timeoutMs: cfg.restoreTimeoutMs }
      );
      const absorbed = load.recent(5);
      const ms = (v) => (v ? `${Math.round(v)}ms` : "n/a");
      // Honest about where the gain shows: if every replica shares the same
      // few CPU cores (one-node Minikube/Kind), per-request latency barely
      // moves even though the Service now spreads the work over more pods.
      const latencyImproved = ctx.state.surgeP95 && absorbed.p95Ms && absorbed.p95Ms < ctx.state.surgeP95 * 0.8;
      const effect = latencyImproved
        ? `p95 latency fell from ${ms(ctx.state.surgeP95)} to ${ms(absorbed.p95Ms)} at ${Math.round(absorbed.requestsPerSec)} req/s.`
        : `p95 latency ${ms(ctx.state.surgeP95)} → ${ms(absorbed.p95Ms)} at ${Math.round(absorbed.requestsPerSec)} req/s (was ${Math.round(ctx.state.surgeRps || 0)}). On a single node all replicas share the same CPU cores, so latency only drops when new pods get spare cores or another node; the platform still did its part by adding replicas automatically.`;
      run.setStage("RESTORED", {
        summary: `Surge absorbed: ${settled.ready} replicas sharing the load (was ${baseline}); ${effect} When the surge ends, the HPA scales back down after its 2-minute stabilization window.`,
        banner: { level: "restored", headline: "CAPACITY RESTORED", detail: `${settled.ready} replicas (from ${baseline}) · p95 ${ms(absorbed.p95Ms)}` },
      });
      await ctx.sleep(cfg.holdMs);
      await load.stop();
      run.log("Surge ended (load generator stopped). Watch the replica count fall back over the next few minutes.");
      run.summary = {
        ...incidentSummary(ctx),
        replicasBefore: baseline,
        replicasAfter: settled.ready,
        p95MsDuringSurge: ctx.state.surgeP95 ? Math.round(ctx.state.surgeP95) : null,
        p95MsAfterScaleOut: absorbed.p95Ms ? Math.round(absorbed.p95Ms) : null,
        requestsPerSecDuringSurge: ctx.state.surgeRps != null ? Math.round(ctx.state.surgeRps) : null,
        requestsPerSecAfterScaleOut: Math.round(absorbed.requestsPerSec),
      };
    },

    async observe(ctx) {
      return {
        kind: "scaling",
        target: await observeTarget(ctx, service),
        load: ctx.state.load ? { series: ctx.state.load.series(), recent: ctx.state.load.recent(5), concurrency: ctx.cfg.load.concurrency } : null,
        traffic: ctx.state.probe?.series() || [],
      };
    },

    async cleanup(ctx) {
      await ctx.state.load?.stop();
      ctx.state.probe?.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 6: message broker failure → queue buildup → recovery
// ---------------------------------------------------------------------------

async function brokerConnectivity(ctx) {
  const results = await Promise.all(
    BROKER_CONNECTIVITY_PROBES.map(async ({ service, port }) => {
      const r = await ctx.request(`${serviceUrl(ctx, service, port)}/health/ready`, { timeoutMs: 1500 });
      const dep = r.json?.dependencies?.rabbitmq;
      const connected = typeof dep === "string" && dep.startsWith("connected");
      return { service, connected, detail: dep || (r.status ? `HTTP ${r.status}` : `unreachable (${r.error || "no ready pods"})`) };
    })
  );
  return results;
}

function brokerFailureScenario({ id, title, description, demonstrates, mechanism, estimatedSeconds }) {
  return {
    id, title, target: "rabbitmq", description, demonstrates, mechanism, estimatedSeconds,

    async run(ctx) {
      const { run, cfg, k8s, rabbit } = ctx;
      run.setStage("NORMAL", {
        summary: "Normal state: RabbitMQ healthy, every service connected; a drill producer publishes 5 events/s and a consumer drains up to 10/s.",
        banner: { level: "normal", headline: "NORMAL STATE", detail: "message broker healthy · events flowing" },
      });
      const brokerPod = await podNow(ctx, BROKER_POD, "rabbitmq");
      if (!brokerPod?.ready) throw new Error(`${BROKER_POD} is not ready; start the drill once RabbitMQ is healthy`);
      ctx.state.brokerUid = (await k8s.getPod(BROKER_POD))?.metadata?.uid;
      await rabbit.ensureDrillTopology();
      await rabbit.purgeDrillQueue();
      const drill = new BrokerDrill({ rabbit, produceEveryMs: cfg.broker.produceEveryMs, consumePerSec: cfg.broker.consumePerSec, consumeEveryMs: cfg.broker.consumeEveryMs });
      ctx.state.drill = drill;
      drill.start();
      run.log("Drill traffic uses its own exchange and durable queue (sentinelcloud.resilience → q.resilience.drill), so it never reaches the real disaster-event pipeline or the live dashboards.");
      await ctx.sleep(cfg.normalMs);

      // Message delay → queue buildup, before the outage.
      drill.pauseConsumer();
      run.log(`Event processing delayed: the drill consumer is stalled while events keep arriving, so the queue builds up (watch the depth climb).`, { kind: "delay" });
      await ctx.sleep(cfg.broker.backlogMs);
      const depthAtFailure = drill.depth;
      ctx.state.depthAtFailure = depthAtFailure;

      await k8s.deletePod(BROKER_POD);
      ctx.state.brokerKilledAt = Date.now();
      run.setStage("FAILURE", {
        summary: `The message broker failed: pod ${BROKER_POD} was terminated with ${depthAtFailure} events waiting in the queue. Nothing can be published or consumed.`,
        banner: { level: "failed", headline: "SERVICE FAILED", detail: `message broker ${BROKER_POD} down · ${depthAtFailure} events queued` },
      });

      const baselineFailures = drill.publishFailures;
      const detected = await waitFor(
        ctx,
        "services to detect the broker outage",
        async () => {
          const conn = await brokerConnectivity(ctx);
          const disconnected = conn.filter((c) => !c.connected);
          return drill.publishFailures > baselineFailures && disconnected.length > 0 ? { conn, disconnected } : null;
        },
        { timeoutMs: cfg.detectTimeoutMs }
      );
      run.setStage("DETECTION", {
        summary: `Detected: publishing fails, so the producer buffers events in its outbox (${drill.outbox.length} so far, none lost). ${detected.disconnected.length}/${detected.conn.length} services report their RabbitMQ connection closed and retry in the background. REST APIs keep working: the gateway doesn't depend on the broker.`,
        evidence: detected.disconnected.map((c) => `${c.service}: ${c.detail}`).join(" · "),
        banner: { level: "detecting", headline: "FAILURE DETECTED", detail: `${detected.disconnected.length} services lost the broker · events buffering in outbox` },
      });

      const back = await waitFor(
        ctx,
        `the StatefulSet to recreate ${BROKER_POD}`,
        async () => {
          const pod = await k8s.getPod(BROKER_POD);
          if (!pod || pod.metadata?.uid === ctx.state.brokerUid || pod.metadata?.deletionTimestamp) return null;
          const s = summarizePod(pod, "rabbitmq");
          return s.ready && (await rabbit.reachable()) ? s : null;
        },
        { timeoutMs: cfg.recoverTimeoutMs }
      );
      const survived = await rabbit.drillQueueDepth();
      drill.resumeConsumer();
      run.setStage("RECOVERY", {
        summary: `The StatefulSet controller recreated ${BROKER_POD} (same name, same PersistentVolume data-${BROKER_POD}) and it passed its readiness probe ${secs(Date.now() - ctx.state.brokerKilledAt)}s after the failure. The durable queue survived the restart${survived ? ` (${survived.messages} messages on the broker)` : ""}. ${drill.outbox.length ? `The outbox is flushing ${drill.outbox.length} buffered events` : `All ${drill.peakOutbox} events buffered during the outage were already delivered from the outbox`}, so the backlog spikes before it drains.`,
        evidence: eventEvidence(await latestEvent(ctx, BROKER_POD, ["Started", "Scheduled", "Created"])),
        banner: { level: "recovering", headline: "SELF-HEALING", detail: `${BROKER_POD} recreated · ${drill.outbox.length ? `flushing ${drill.outbox.length} buffered events` : `${drill.peakOutbox} buffered events delivered`} · draining backlog` },
      });

      const restored = await waitFor(
        ctx,
        "the backlog to drain and every service to reconnect",
        async () => {
          if (!drill.isDrained()) return null;
          const conn = await brokerConnectivity(ctx);
          return conn.every((c) => c.connected) ? conn : null;
        },
        { timeoutMs: cfg.restoreTimeoutMs }
      );
      const snap = drill.snapshot();
      run.setStage("RESTORED", {
        summary: `Backlog drained (peak ${snap.peakDepth} events queued, ${snap.peakOutbox} buffered during the outage) and ${restored.length}/${restored.length} services reconnected on their own. Events lost: ${snap.produced - snap.published - snap.outbox}.`,
        banner: { level: "restored", headline: "SERVICE RESTORED", detail: `broker healthy · backlog drained · ${restored.length}/${restored.length} services reconnected · 0 events lost` },
      });
      await ctx.sleep(cfg.holdMs);
      const final = drill.snapshot();
      run.summary = {
        ...incidentSummary(ctx),
        brokerOutageSec: secs(Date.parse(run.stages.find((s) => s.stage === "RECOVERY").enteredAt) - ctx.state.brokerKilledAt),
        queuedAtFailure: depthAtFailure,
        peakQueueDepth: final.peakDepth,
        peakBufferedInOutbox: final.peakOutbox,
        eventsProduced: final.produced,
        eventsDelivered: final.consumed,
        eventsLost: final.produced - final.published - final.outbox,
      };
    },

    async observe(ctx) {
      const [pod, conn] = await Promise.all([podNow(ctx, BROKER_POD, "rabbitmq").catch(() => null), brokerConnectivity(ctx)]);
      return {
        kind: "broker",
        broker: pod,
        services: conn,
        queue: ctx.state.drill ? { ...ctx.state.drill.snapshot(), series: ctx.state.drill.series() } : null,
      };
    },

    async cleanup(ctx) {
      ctx.state.drill?.stop();
      try {
        await ctx.rabbit.purgeDrillQueue();
      } catch {
        /* broker may still be down; the drill queue is isolated anyway */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export function buildScenarios() {
  return [
    podFaultScenario({
      id: "hospital-failure",
      title: "Hospital service failure",
      service: "hospital-service",
      mode: "unhealthy",
      failureText: "stopped responding: every request, including its health checks, now returns 503 (simulated hang)",
      bannerText: "is hung (all requests return 503)",
      description: "One hospital-service replica hangs. Kubernetes' health checks notice, take it out of load balancing, then restart it.",
      demonstrates: ["Health checks", "Load balancing", "Container restart"],
      mechanism: "readiness probe → endpoint removal; liveness probe → kubelet restart",
      estimatedSeconds: 75,
    }),
    podFaultScenario({
      id: "ambulance-failure",
      title: "Ambulance service failure",
      service: "ambulance-service",
      mode: "crash",
      failureText: "crashed: the process exited with code 1",
      bannerText: "crashed (exit code 1)",
      description: "One ambulance-service replica crashes. The kubelet restarts the container while the other replica keeps dispatching.",
      demonstrates: ["Container restart", "Load balancing", "Health checks"],
      mechanism: "process exit → kubelet restart (restartPolicy: Always)",
      estimatedSeconds: 45,
    }),
    podFaultScenario({
      id: "blood-failure",
      title: "Blood bank service failure",
      service: "blood-bank-service",
      mode: "unhealthy",
      failureText: "reports itself broken: Spring Boot LivenessState = BROKEN, ReadinessState = REFUSING_TRAFFIC",
      bannerText: "reports itself broken (LivenessState BROKEN)",
      description: "One blood-bank-service (Spring Boot) replica declares itself broken through Spring's availability API. Its actuator probes fail and Kubernetes restarts the JVM.",
      demonstrates: ["Health checks", "Container restart", "Load balancing"],
      mechanism: "Spring /health/readiness + /health/liveness → endpoint removal, then kubelet restart",
      estimatedSeconds: 150,
    }),
    podLossScenario({
      id: "power-failure",
      title: "Power service failure",
      service: "power-service",
      description: "A power-service pod is lost entirely, as if its node died. The ReplicaSet notices it's short a replica and creates a brand-new pod.",
      demonstrates: ["Replica recovery", "Load balancing", "Health checks"],
      mechanism: "pod deletion → endpoint removal → ReplicaSet creates a replacement",
      estimatedSeconds: 120,
    }),
    trafficSurgeScenario({
      id: "traffic-surge",
      title: "High emergency traffic",
      service: "ambulance-service",
      description: "A mass-casualty surge of CPU-heavy requests hits ambulance-service. The HorizontalPodAutoscaler scales it out and the Service spreads the load.",
      demonstrates: ["Horizontal scaling", "Load balancing"],
      mechanism: "CPU > HPA target → more replicas → kube-proxy spreads traffic",
      estimatedSeconds: 150,
    }),
    brokerFailureScenario({
      id: "broker-failure",
      title: "Message broker failure",
      description: "Event processing stalls and the queue builds up, then the RabbitMQ broker itself dies. Events are buffered, the StatefulSet recreates the broker on its persistent volume, services reconnect and the backlog drains.",
      demonstrates: ["Event queue buildup", "Replica recovery", "Health checks"],
      mechanism: "pod deletion → StatefulSet recreates rabbitmq-0 (same PVC) → services auto-reconnect",
      estimatedSeconds: 120,
    }),
  ];
}
