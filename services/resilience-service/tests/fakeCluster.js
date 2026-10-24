/**
 * A tiny, time-compressed simulation of the parts of Kubernetes (and
 * RabbitMQ) the resilience drills observe, so every scenario can be
 * exercised end to end in unit tests. Behaviour modelled on the real
 * thing:
 *   - kubelet: an "unhealthy" pod goes NotReady (readiness), then is
 *     restarted (liveness); a crashed container restarts; restarts clear
 *     the in-memory fault; readiness returns after startup
 *   - endpoint controller: only ready, non-terminating pods receive traffic
 *   - ReplicaSet: deleted pods are replaced by new pods with new names
 *   - HPA: CPU load raises desiredReplicas; minReplicas patches add pods
 *   - kube-proxy: each request goes to a random ready endpoint; a pod
 *     that's faulty but still in the endpoints returns 503
 *   - RabbitMQ: deleting rabbitmq-0 makes the management API unreachable
 *     until the StatefulSet's replacement is ready; the durable queue persists
 */
export const T = {
  readinessFail: 40, // ms after an "unhealthy" fault before Ready=false
  livenessKill: 90, // ms after the fault before the kubelet restarts the container
  crashRestart: 30,
  startup: 50, // ms from container (re)start to Ready
  terminate: 30,
  schedule: 20,
  hpaReact: 60,
  brokerDown: 120,
  reconnect: 30,
};

let ipCounter = 10;

export function createFakeCluster({ services = ["hospital-service", "ambulance-service", "blood-bank-service", "power-service"], hpaReacts = true } = {}) {
  const now = () => Date.now();
  const pods = new Map(); // name → pod
  const events = []; // { involved, reason, message, source, at }
  const hpas = new Map();
  const ports = { "hospital-service": 8082, "ambulance-service": 8083, "blood-bank-service": 8084, "power-service": 8085 };
  let loadHits = [];
  const patches = [];
  const deleted = [];

  const broker = { up: true, upSince: now(), uid: "rmq-1", deletedAt: null, queue: 0, topology: false };

  function event(involved, reason, message, source = "kubelet") {
    events.push({ involved, reason, message, source, at: new Date().toISOString() });
  }

  function newPod(service, suffix) {
    const name = `${service}-7d9f8c6b5-${suffix || Math.random().toString(36).slice(2, 7)}`;
    const pod = { name, service, ip: `10.42.0.${ipCounter++}`, restarts: 0, ready: false, state: "running", startedAt: now(), fault: null, faultAt: null, deleting: false, deletedAt: null, lastTermination: null };
    pods.set(name, pod);
    event(name, "Scheduled", `Successfully assigned sentinelcloud/${name} to node-1`, "default-scheduler");
    return pod;
  }

  for (const s of services) {
    hpas.set(s, { min: 1, max: 5, current: 1, desired: 1, cpu: 3, target: 70 });
    const p = newPod(s, "aaaaa");
    p.ready = true;
    p.startedAt = now() - 10_000;
  }

  function servicePods(s) {
    return [...pods.values()].filter((p) => p.service === s);
  }

  // --- the control loops -------------------------------------------------
  const loop = setInterval(() => {
    const t = now();
    for (const p of [...pods.values()]) {
      if (p.deleting) {
        if (t - p.deletedAt >= T.terminate) pods.delete(p.name);
        continue;
      }
      if (p.fault === "unhealthy") {
        if (p.ready && t - p.faultAt >= T.readinessFail) {
          p.ready = false;
          event(p.name, "Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503");
        }
        if (t - p.faultAt >= T.livenessKill) {
          event(p.name, "Killing", `Container ${p.service} failed liveness probe, will be restarted`);
          p.restarts += 1;
          p.fault = null;
          p.state = "running";
          p.startedAt = t;
          event(p.name, "Started", `Started container ${p.service}`);
        }
      }
      if (p.state === "terminated" && t - p.faultAt >= T.crashRestart) {
        p.restarts += 1;
        p.state = "running";
        p.startedAt = t;
        event(p.name, "Started", `Started container ${p.service}`);
      }
      if (p.state === "running" && !p.fault && !p.ready && t - p.startedAt >= T.startup) p.ready = true;
    }
    // ReplicaSet + HPA
    for (const [s, h] of hpas) {
      const recentLoad = loadHits.filter((x) => x.service === s && t - x.at < 300).length;
      if (hpaReacts && recentLoad > 0 && h.desired < 3 && h.loadSince && t - h.loadSince >= T.hpaReact) {
        h.cpu = 240;
        h.desired = Math.min(h.max, 3);
        event(s, "SuccessfulRescale", `New size: ${h.desired}; reason: cpu resource utilization (percentage of request) above target`, "horizontal-pod-autoscaler");
      }
      if (recentLoad > 0 && !h.loadSince) h.loadSince = t;
      const want = Math.max(h.min, h.desired);
      const live = servicePods(s).filter((p) => !p.deleting);
      if (live.length < want && !h.pendingCreate) {
        h.pendingCreate = true;
        setTimeout(() => {
          newPod(s);
          h.pendingCreate = false;
        }, T.schedule);
      }
      h.current = servicePods(s).filter((p) => !p.deleting).length;
    }
    // broker
    if (!broker.up && broker.deletedAt && t - broker.deletedAt >= T.brokerDown) {
      broker.up = true;
      broker.upSince = t;
      broker.uid = `rmq-${Math.random().toString(36).slice(2, 6)}`;
    }
    loadHits = loadHits.filter((x) => t - x.at < 1000);
  }, 5);

  // --- Kubernetes API objects -----------------------------------------------
  function podObject(p) {
    const container = { name: p.service, restartCount: p.restarts };
    if (p.state === "terminated") container.state = { terminated: { reason: "Error", exitCode: 1 } };
    else container.state = { running: { startedAt: new Date(p.startedAt).toISOString() } };
    if (p.lastTermination) container.lastState = { terminated: p.lastTermination };
    return {
      metadata: { name: p.name, uid: p.name, creationTimestamp: new Date().toISOString(), ...(p.deleting ? { deletionTimestamp: new Date(p.deletedAt).toISOString() } : {}) },
      spec: { nodeName: "node-1" },
      status: { phase: "Running", podIP: p.ip, conditions: [{ type: "Ready", status: p.ready ? "True" : "False" }], containerStatuses: [container] },
    };
  }

  function brokerPodObject() {
    if (!broker.up) {
      if (broker.deletedAt && now() - broker.deletedAt < T.terminate) {
        return { metadata: { name: "rabbitmq-0", uid: "old", deletionTimestamp: "x" }, status: { conditions: [], containerStatuses: [] } };
      }
      return null;
    }
    return {
      metadata: { name: "rabbitmq-0", uid: broker.uid },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "rabbitmq", restartCount: 0, state: { running: {} } }] },
    };
  }

  const k8s = {
    namespace: "sentinelcloud",
    async listPods(selector) {
      const s = selector.split("=")[1];
      if (s === "rabbitmq") return [brokerPodObject()].filter(Boolean);
      return servicePods(s).map(podObject);
    },
    async getPod(name) {
      if (name === "rabbitmq-0") return brokerPodObject();
      const p = pods.get(name);
      return p ? podObject(p) : null;
    },
    async deletePod(name) {
      deleted.push(name);
      if (name === "rabbitmq-0") {
        broker.up = false;
        broker.deletedAt = now();
        return {};
      }
      const p = pods.get(name);
      p.deleting = true;
      p.deletedAt = now();
      p.ready = false;
      return {};
    },
    async listEndpointSlices(service) {
      return [{ endpoints: servicePods(service).map((p) => ({ targetRef: { name: p.name }, addresses: [p.ip], conditions: { ready: p.ready && !p.deleting, terminating: p.deleting } })) }];
    },
    async listEvents(name) {
      return events.filter((e) => e.involved === name).map((e) => ({ reason: e.reason, message: e.message, source: { component: e.source }, lastTimestamp: e.at, type: "Normal" }));
    },
    async getHpa(name) {
      const h = hpas.get(name);
      if (!h) return null;
      return {
        metadata: { name },
        spec: { minReplicas: h.min, maxReplicas: h.max, metrics: [{ resource: { name: "cpu", target: { averageUtilization: h.target } } }] },
        status: { currentReplicas: h.current, desiredReplicas: Math.max(h.min, h.desired), currentMetrics: [{ resource: { name: "cpu", current: { averageUtilization: h.cpu } } }] },
      };
    },
    async patchHpa(name, patch) {
      patches.push({ name, patch });
      hpas.get(name).min = patch.spec.minReplicas;
      return {};
    },
  };

  // --- HTTP (kube-proxy + services + RabbitMQ management API) ---------------
  function pickEndpoint(service) {
    const eps = servicePods(service).filter((p) => p.ready && !p.deleting);
    // Endpoint propagation lag: a pod that just went faulty is still routed to until Ready flips.
    const faultyStillListed = servicePods(service).filter((p) => p.fault === "unhealthy" && p.ready);
    const candidates = [...eps, ...faultyStillListed];
    return candidates[Math.floor(Math.random() * candidates.length)] || null;
  }

  function respondFromPod(p, body) {
    if (!p) return { ok: false, status: 0, error: "ECONNREFUSED", ms: 1, json: null };
    if (p.state === "terminated") return { ok: false, status: 0, error: "ECONNREFUSED", ms: 1, json: null };
    if (p.fault === "unhealthy") return { ok: false, status: 503, ms: 1, json: { error: { code: "SIMULATED_FAILURE" }, pod: p.name } };
    return { ok: true, status: 200, ms: 2 + Math.random() * 3, json: { pod: p.name, ...body } };
  }

  const brokerOk = () => broker.up && now() - broker.upSince >= 0;
  const connected = () => broker.up && now() - broker.upSince >= T.reconnect;

  async function request(urlStr, { method = "GET", body } = {}) {
    const url = new URL(urlStr);
    const host = url.hostname;
    const path = url.pathname;

    if (host === "rabbitmq") {
      if (!brokerOk()) return { ok: false, status: 0, error: "ECONNREFUSED", ms: 1, json: null };
      if (method === "PUT" || (method === "POST" && path.includes("/bindings/"))) {
        broker.topology = true;
        return { ok: true, status: 201, json: null };
      }
      if (path.endsWith("/publish")) {
        broker.queue += 1;
        return { ok: true, status: 200, json: { routed: true } };
      }
      if (path.endsWith("/get")) {
        const n = Math.min(body.count, broker.queue);
        broker.queue -= n;
        return { ok: true, status: 200, json: Array.from({ length: n }, () => ({})) };
      }
      if (path.endsWith("/contents") && method === "DELETE") {
        broker.queue = 0;
        return { ok: true, status: 204, json: null };
      }
      if (path.includes("/queues/")) return { ok: true, status: 200, json: { messages: broker.queue, messages_ready: broker.queue, messages_unacknowledged: 0, durable: true } };
      return { ok: true, status: 200, json: {} };
    }

    const byIp = [...pods.values()].find((p) => p.ip === host);
    if (byIp && path === "/internal/chaos") {
      const mode = url.searchParams.get("mode");
      if (byIp.state === "terminated" || byIp.deleting) return { ok: false, status: 0, error: "ECONNREFUSED", json: null };
      if (mode === "clear") {
        byIp.fault = null;
        return { ok: true, status: 200, json: { pod: byIp.name } };
      }
      if (mode === "crash") {
        byIp.state = "terminated";
        byIp.ready = false;
        byIp.faultAt = now();
        byIp.lastTermination = { reason: "Error", exitCode: 1 };
        return { ok: true, status: 202, json: { pod: byIp.name } };
      }
      byIp.fault = mode;
      byIp.faultAt = now();
      return { ok: true, status: 200, json: { pod: byIp.name } };
    }

    const service = host;
    if (path === "/internal/whoami") return respondFromPod(pickEndpoint(service), { service });
    if (path === "/internal/work") {
      const p = pickEndpoint(service);
      if (p) loadHits.push({ service, at: now() });
      return respondFromPod(p, { service });
    }
    if (path === "/health/ready") {
      const ready = { gateway: true, "hospital-service": true, "ambulance-service": true }[service];
      const c = connected();
      if (!c && !ready) return { ok: false, status: 0, error: "ECONNREFUSED", json: null }; // broker-dependent readiness → no endpoints
      return { ok: true, status: 200, json: { dependencies: { rabbitmq: c ? "connected" : "disconnected (Connection closed, non-blocking)" } } };
    }
    return { ok: false, status: 404, json: null };
  }

  return {
    k8s,
    request,
    stop: () => clearInterval(loop),
    pods,
    hpas,
    patches,
    deleted,
    broker,
    servicePods,
    ports,
    readyCount: (s) => servicePods(s).filter((p) => p.ready && !p.deleting).length,
  };
}
