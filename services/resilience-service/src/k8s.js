/**
 * Minimal Kubernetes API client (zero dependencies) using the pod's own
 * ServiceAccount, the standard "in-cluster config": the token and CA
 * mounted at /var/run/secrets/kubernetes.io/serviceaccount.
 *
 * Covers exactly what the Resilience Demo needs, all inside ONE
 * namespace, matching the Role in k8s/base/apps/resilience-service.yaml:
 *   pods: list/get/delete · endpointslices: list · events: list
 *   deployments/statefulsets: get · horizontalpodautoscalers: get/patch
 */
import fs from "node:fs";
import https from "node:https";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export function inClusterAvailable(dir = SERVICE_ACCOUNT_DIR) {
  return fs.existsSync(`${dir}/token`) && fs.existsSync(`${dir}/ca.crt`);
}

export function createK8sClient({
  namespace,
  host = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc",
  port = Number(process.env.KUBERNETES_SERVICE_PORT || 443),
  saDir = SERVICE_ACCOUNT_DIR,
  timeoutMs = 5000,
} = {}) {
  const ns = encodeURIComponent(namespace);

  function call(method, path, body, contentType = "application/json") {
    // Re-read every call: projected ServiceAccount tokens are rotated by the kubelet.
    const token = fs.readFileSync(`${saDir}/token`, "utf8").trim();
    const ca = fs.readFileSync(`${saDir}/ca.crt`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host,
          port,
          path,
          method,
          ca,
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(payload !== undefined ? { "Content-Type": contentType, "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            let json = null;
            try {
              json = data ? JSON.parse(data) : null;
            } catch {
              json = null;
            }
            if (res.statusCode >= 400) {
              const err = new Error(`Kubernetes API ${method} ${path} → ${res.statusCode}: ${json?.message || data.slice(0, 200)}`);
              err.status = res.statusCode;
              reject(err);
            } else {
              resolve(json);
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error(`Kubernetes API ${method} ${path} timed out`)));
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const q = (s) => encodeURIComponent(s);
  return {
    namespace,
    listPods: (labelSelector) => call("GET", `/api/v1/namespaces/${ns}/pods?labelSelector=${q(labelSelector)}`).then((r) => r.items || []),
    getPod: (name) =>
      call("GET", `/api/v1/namespaces/${ns}/pods/${q(name)}`).catch((err) => {
        if (err.status === 404) return null;
        throw err;
      }),
    deletePod: (name) => call("DELETE", `/api/v1/namespaces/${ns}/pods/${q(name)}`),
    listEndpointSlices: (service) =>
      call("GET", `/apis/discovery.k8s.io/v1/namespaces/${ns}/endpointslices?labelSelector=${q(`kubernetes.io/service-name=${service}`)}`).then((r) => r.items || []),
    listEvents: (objectName) =>
      call("GET", `/api/v1/namespaces/${ns}/events?fieldSelector=${q(`involvedObject.name=${objectName}`)}`).then((r) => r.items || []),
    getDeployment: (name) => call("GET", `/apis/apps/v1/namespaces/${ns}/deployments/${q(name)}`),
    getStatefulSet: (name) => call("GET", `/apis/apps/v1/namespaces/${ns}/statefulsets/${q(name)}`),
    getHpa: (name) =>
      call("GET", `/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers/${q(name)}`).catch((err) => {
        if (err.status === 404) return null;
        throw err;
      }),
    patchHpa: (name, patch) =>
      call("PATCH", `/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers/${q(name)}`, patch, "application/merge-patch+json"),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers: Kubernetes objects → the compact shapes the demo page shows
// ---------------------------------------------------------------------------

export function summarizePod(pod, containerName) {
  const statuses = pod.status?.containerStatuses || [];
  const cs = statuses.find((c) => c.name === containerName) || statuses[0];
  const ready = (pod.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True");
  const deleting = Boolean(pod.metadata?.deletionTimestamp);
  let state = "pending";
  let reason = null;
  if (deleting) state = "terminating";
  else if (cs?.state?.running) state = ready ? "ready" : "running-not-ready";
  else if (cs?.state?.waiting) {
    state = "waiting";
    reason = cs.state.waiting.reason || null;
  } else if (cs?.state?.terminated) {
    state = "terminated";
    reason = cs.state.terminated.reason || null;
  } else if ((pod.status?.initContainerStatuses || []).some((c) => !c.ready)) {
    state = "initializing";
  }
  const last = cs?.lastState?.terminated;
  return {
    name: pod.metadata?.name,
    ip: pod.status?.podIP || null,
    node: pod.spec?.nodeName || null,
    phase: pod.status?.phase || "Unknown",
    ready,
    state,
    reason,
    restarts: cs?.restartCount ?? 0,
    lastTermination: last ? { reason: last.reason || null, exitCode: last.exitCode ?? null, finishedAt: last.finishedAt || null } : null,
    createdAt: pod.metadata?.creationTimestamp || null,
    startedAt: cs?.state?.running?.startedAt || null,
  };
}

export function summarizeEndpoints(slices) {
  const out = [];
  for (const slice of slices) {
    for (const ep of slice.endpoints || []) {
      out.push({
        pod: ep.targetRef?.name || null,
        ip: ep.addresses?.[0] || null,
        ready: ep.conditions?.ready !== false,
        terminating: Boolean(ep.conditions?.terminating),
      });
    }
  }
  return out.sort((a, b) => String(a.pod).localeCompare(String(b.pod)));
}

export function summarizeHpa(hpa) {
  if (!hpa) return null;
  const cpu = (hpa.status?.currentMetrics || []).find((m) => m.resource?.name === "cpu");
  const target = (hpa.spec?.metrics || []).find((m) => m.resource?.name === "cpu");
  return {
    name: hpa.metadata?.name,
    minReplicas: hpa.spec?.minReplicas ?? 1,
    maxReplicas: hpa.spec?.maxReplicas ?? null,
    currentReplicas: hpa.status?.currentReplicas ?? null,
    desiredReplicas: hpa.status?.desiredReplicas ?? null,
    cpuPercent: cpu?.resource?.current?.averageUtilization ?? null,
    targetCpuPercent: target?.resource?.target?.averageUtilization ?? null,
  };
}

/** Newest-first events, compact. */
export function summarizeEvents(events) {
  return events
    .map((e) => ({
      at: e.lastTimestamp || e.eventTime || e.firstTimestamp || e.metadata?.creationTimestamp || null,
      type: e.type,
      reason: e.reason,
      message: e.message,
      source: e.source?.component || e.reportingComponent || null,
      count: e.count ?? 1,
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
