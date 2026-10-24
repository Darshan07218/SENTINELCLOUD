# Phase 10 — Monitoring and Observability

> **Note (Phases 12–13).** Commands and behaviour in this phase document
> predate the security hardening and the engineering review. Notably: sign-up
> always creates a `CITIZEN` (no `role` field), the refresh token is an
> httpOnly cookie (login returns `accessToken`, not `session.accessToken`),
> every service except `/auth/docs` requires a Bearer token, and secrets come
> from `./scripts/generate-secrets.sh`. Current commands:
> [`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md), [`../SECURITY.md`](../SECURITY.md).


## Goal

Make SentinelCloud **observable**: from one screen, see whether every
service is up, how fast and how reliably it answers, how much CPU and
memory it uses, whether events flow through RabbitMQ on time, and
whether Kubernetes is keeping the pods healthy. Then **get told
automatically** when any of that goes wrong.

Everything runs locally and free: Prometheus, Alertmanager, Grafana and
kube-state-metrics are open-source containers in the same cluster
(or Compose stack) as the application.

---

## 1. Architecture

```
            ┌──────────────────────────── namespace: sentinelcloud ─────────────────────────────┐
            │                                                                                    │
            │  8 SentinelCloud services ── GET /metrics (Node, src/metrics.js)                   │
            │        (pods annotated      GET /prometheus (Spring, Actuator + Micrometer)        │
            │   prometheus.io/scrape)            ▲                                               │
            │                                    │ scrape every 15s (pods found via the K8s API) │
            │  RabbitMQ :15692 ─────────────────►│                                               │
            │  kube-state-metrics :8080 ────────►│  Prometheus ──► recording rules (15)          │
            │  kubelet/cAdvisor (via API proxy) ►│  (PVC 2Gi)  ──► alert rules (19) ──┐          │
            │                                    │                                    ▼          │
            │                     Grafana ◄──────┘   (PromQL)            Alertmanager            │
            │            4 provisioned dashboards                group · inhibit · silence ·     │
            │       (System Health = home page)                   route to receivers             │
            └────────────────────────────────────────────────────────────────────────────────────┘
       browser: Grafana :30030 · Prometheus :30090 · Alertmanager :30093   (Kind; port-forward elsewhere)
```

| Component | What it does here | Where it's defined |
|---|---|---|
| **Instrumentation** | every service exposes metrics in Prometheus text format | `services/*/src/metrics.js`; Spring `event/EventMetrics.java`, `config/ObservabilityMetrics.java`, `application.yml` |
| **Prometheus** | scrapes, stores 3 days of history, evaluates rules | `k8s/base/monitoring/prometheus.yaml` + `config/prometheus/` |
| **kube-state-metrics** | Kubernetes object state: pod phase/readiness, restarts, CrashLoopBackOff, limits, HPA | `k8s/base/monitoring/kube-state-metrics.yaml` |
| **cAdvisor** | per-pod CPU/memory, built into every kubelet (nothing to deploy) | scraped through the API server proxy |
| **Alertmanager** | groups, de-duplicates, inhibits and routes alerts | `k8s/base/monitoring/alertmanager.yaml` + `config/alertmanager/` |
| **Grafana** | dashboards, fully provisioned from files | `k8s/base/monitoring/grafana.yaml` + `config/grafana/` |

**One source of truth.** Rules, alerting config, Grafana datasources and
dashboards live once, in `k8s/base/monitoring/config/`. Kubernetes loads
them through Kustomize ConfigMap generators. `docker-compose.yml`
bind-mounts the **same files**. Only the scrape config differs:
Kubernetes service discovery vs. Compose static targets
(`infrastructure/prometheus/prometheus.yml`). Both use the same job
names, so every rule and panel works in both.

**Config changes roll out automatically.** The ConfigMaps get a content
hash in their name. Edit a rule or dashboard, run
`kubectl apply -k k8s/overlays/local`, and Prometheus or Grafana
restarts with it.

---

## 2. What is monitored, mapped to each requirement

| Requirement | Metric(s) | Source | Where you see it |
|---|---|---|---|
| **CPU usage** | `process_cpu_seconds_total` (per process) · `container_cpu_usage_seconds_total` (per pod, vs. limit) | services · cAdvisor | System Health → *Resources*; Kubernetes → *CPU used / limit*, *CPU throttling* |
| **Memory** | `process_resident_memory_bytes` · `container_memory_working_set_bytes` (vs. limit) · `jvm_memory_used_bytes` | services · cAdvisor · Micrometer | System Health → *Resources*; Kubernetes; Service Detail → *JVM heap* |
| **Request count** | `http_server_requests_seconds_count` | all 8 services | System Health → *Request rate*, *Requests/second by service*; Service Detail → *by route* |
| **Request latency** | `http_server_requests_seconds_bucket` (histogram) → p50/p95/p99 | all 8 services | System Health → *API latency p95*; Service Detail → percentiles + **heatmap** |
| **Error rate** | 5xx share of `http_server_requests_seconds_count` | all 8 services | System Health → *Error rate*, *5xx ratio by service*; Service Detail → *5xx by route* |
| **Service availability** | `up` (scrape success) · `sentinel_dependency_up` · `avg_over_time(up[range])` | Prometheus · services | System Health → *Services up*, *up/down timeline*, *Availability %*, *Dependencies* |
| **Container restarts** | `kube_pod_container_status_restarts_total` · `…_last_terminated_reason` (OOMKilled) | kube-state-metrics | System Health → *Container restarts (1h)*; Kubernetes → *Restarts per container* |
| **Kubernetes pod health** | `kube_pod_status_phase` · `kube_pod_status_ready` · `kube_pod_container_status_waiting_reason` · deployment & HPA replicas | kube-state-metrics | System Health → *Pods not ready*, *Kubernetes pod health*; Kubernetes dashboard |
| **Event-processing latency** | `sentinel_event_processing_seconds` (publish → handled) · `sentinel_event_handler_seconds` (handler only) · `sentinel_events_consumed_total` / `…published_total` · queue depth | services · RabbitMQ | System Health → *Event latency p95*; **Event Bus** dashboard |

### The SentinelCloud metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `http_server_requests_seconds` | histogram | `method, uri, status, outcome` | request duration; `uri` is the route **template** (`/hospitals/:id`), never the raw path |
| `sentinel_event_processing_seconds` | histogram | `queue, event_type, outcome` | envelope `occurredAt` (publisher's clock) → this consumer finished |
| `sentinel_event_handler_seconds` | histogram | `queue, event_type, outcome` | handler run time only (processing − handler ≈ time spent queued) |
| `sentinel_events_consumed_total` | counter | `queue, event_type, outcome` | outcome: `success`, `error` (handler threw), `invalid` (bad JSON) |
| `sentinel_events_published_total` | counter | `event_type` | events this service published |
| `sentinel_dependency_up` | gauge | `dependency` | 1/0: can this service reach `postgres` / `rabbitmq` / `redis` right now |
| `sentinel_websocket_clients` | gauge | — | live-feed browsers connected to this notification-service replica |
| `process_cpu_seconds_total`, `process_resident_memory_bytes` | counter, gauge | — | same names in Node and Java |
| `nodejs_eventloop_lag_{p50,p99,max}_seconds` | gauge | — | Node only: how long every request waits for the event loop |

### Design decisions worth explaining

**1. Identical metric names in Node and Java.** Spring's Micrometer
names its HTTP histogram `http_server_requests_seconds` with labels
`method/uri/status/outcome`. The Node module emits exactly that: same
name, same labels, same buckets (5ms … 10s, set in both
`metrics.js` and `application.yml`), and even the same `le` formatting
(`"1.0"`, not `"1"`). So one PromQL expression covers all eight
services, and no dashboard or alert has per-language variants.

**2. A hand-written `metrics.js` instead of `prom-client`.** This is a
deviation from `ARCHITECTURE.md` §9, for the same reason the project
hand-rolled its migration runner. The Prometheus text format is
simple. ~400 heavily-commented lines are easier to explain in a viva than a
library's internals, and adding no dependency means no lockfile churn
in six services. It ships with a 12-test suite (`tests/metrics.test.js`
in every Node service), and its output is linted clean by the official
`promtool check metrics`. Process metric names match `prom-client`'s,
so community dashboards still work.

**3. Route templates, not paths.** Recording `/hospitals/42` and
`/hospitals/43` as separate label values would create one time series
per id: unbounded cardinality, the classic way to run Prometheus out
of memory. Requests that match no route are bucketed by mount point
(`/api/v1/hospitals/**`) or `NOT_FOUND`.

**4. Probes excluded from golden signals.** Kubernetes hits every
pod's `/health*` endpoints every 5–10s. Counting those would bury real
traffic and drag latency percentiles down. Every recording rule
excludes `/health*`, `/metrics`, `/prometheus` and actuator paths.

**5. Recording rules.** "Request rate", "error ratio" and "p95 latency"
are each defined once (`config/prometheus/rules/recording.rules.yml`).
Dashboards and alerts read the same series, so a panel and the alert
that fires on it can never disagree.

**6. Per-pod resource metrics from cAdvisor's pod cgroup.** Every
kubelet reports the pod-level cgroup, while per-container series
depend on the container runtime. They were missing entirely on the
Docker-based test cluster. SentinelCloud pods run one app container
each, so pod usage = container usage. The service (`job`) is derived
from the pod name.

---

## 3. Alerts

19 alert rules in `config/prometheus/rules/alerts.rules.yml`. Each has a
`severity`, a human-readable summary and description, and a `runbook`
link to the matching section below.

| Requirement | Alert | Severity | Condition | For |
|---|---|---|---|---|
| **Service down** | `SentinelServiceDown` | critical | a service's metrics endpoint can't be scraped (`up == 0`) | 1m |
| | `SentinelDeploymentUnavailable` | critical | a Deployment has 0 ready replicas (but wants > 0) | 2m |
| | `SentinelDependencyUnreachable` | critical | a service can't reach Postgres/Redis | 2m |
| **High CPU** | `SentinelHighCpu` | warning | pod CPU > 85% of its limit | 5m |
| | `SentinelNodeEventLoopLag` | warning | Node event-loop p99 delay > 500ms | 5m |
| **High memory** | `SentinelHighMemory` | warning | pod memory > 90% of its limit | 5m |
| **High API latency** | `SentinelHighApiLatency` | warning | p95 > 1s, with > 0.05 req/s of real traffic | 5m |
| **Excessive errors** | `SentinelHighErrorRate` | critical | > 5% of requests return 5xx, with > 0.1 req/s | 5m |
| **Pod crash loops** | `SentinelPodCrashLooping` | critical | a container is in `CrashLoopBackOff` | 1m |
| | `SentinelPodRestartingFrequently` | warning | > 2 restarts in 15 minutes | — |
| | `SentinelPodNotReady` | warning | a pod fails readiness | 5m |
| **Message broker failure** | `SentinelRabbitMQDown` | critical | RabbitMQ's metrics endpoint unreachable | 1m |
| | `SentinelServiceLostBrokerConnection` | critical | a service's own RabbitMQ connection is down | 2m |
| | `SentinelQueueBacklog` | warning | > 100 ready messages in a queue | 5m |
| | `SentinelQueueWithoutConsumers` | warning | a `q.*` queue has messages but 0 consumers | 5m |
| Event pipeline | `SentinelSlowEventProcessing` | warning | publish → handled p95 > 5s | 5m |
| | `SentinelEventHandlerErrors` | warning | events failing in a consumer | 5m |
| Capacity | `SentinelHpaAtMaxReplicas` | info | HPA pinned at `maxReplicas` | 10m |
| Meta | `SentinelMonitoringTargetDown` | warning | kube-state-metrics / Alertmanager / Grafana not scraped | 5m |

**Why `for:` durations and traffic guards.** `for` means "true
continuously for this long", so one slow request or a 10-second blip
doesn't page anyone. The latency and error alerts also require a
minimum request rate: one failed request on an idle service is 100%
errors, but it isn't an incident.

### Alertmanager: grouping and inhibition

`config/alertmanager/alertmanager.yml` groups alerts by
`alertname, job, namespace`. It also **inhibits** symptoms when their
root cause is already alerting:

| When this fires… | …these are suppressed |
|---|---|
| `SentinelRabbitMQDown` | `ServiceLostBrokerConnection`, `QueueWithoutConsumers`, `QueueBacklog`, `EventHandlerErrors`; disaster/notification-service `DeploymentUnavailable` / `PodNotReady` (their readiness requires the broker) |
| `SentinelServiceDown` (same `job`) | that service's latency, error, broker and dependency alerts |
| `SentinelPodCrashLooping` (same pod) | `PodNotReady`, `PodRestartingFrequently` |
| any critical | the warning with the same alertname/job/namespace |

Verified on a live Alertmanager (§9): during a broker outage, the
broker-side effects were suppressed, while an unrelated `auth-service`
outage posted at the same time stayed **active**.

The default receiver has no integrations, so nothing is sent anywhere
by default and no account or secret is needed. Alerts are visible in
the Alertmanager UI, Prometheus `/alerts` and Grafana. To receive
notifications, add an `email_configs` / `slack_configs` /
`webhook_configs` block to the `sentinelcloud-oncall` receiver (a
commented example is in the file).

### Alert runbooks

#### Alert: SentinelServiceDown
Prometheus can't scrape the service: the process is dead or hung, or
(in Compose) the container is stopped.
`kubectl get pods -n sentinelcloud -l app.kubernetes.io/name=<job>`, then
`kubectl logs … --previous`. Compose: `docker compose ps <service>`.

#### Alert: SentinelDeploymentUnavailable
No ready replicas, so every request to that service fails (the gateway
returns 502).
`kubectl describe deployment <name> -n sentinelcloud`. Usually a failing
readiness probe (see `SentinelDependencyUnreachable`) or pods stuck
`Pending` (insufficient CPU/memory).

#### Alert: SentinelDependencyUnreachable
The service reports Postgres or Redis unreachable. Its readiness probe
is failing too, so it's out of rotation.
`kubectl get pods -n sentinelcloud -l app.kubernetes.io/name=postgres`;
`kubectl logs statefulset/postgres -n sentinelcloud`.

#### Alert: SentinelHighApiLatency
p95 latency above 1s. Open **Service Detail** for that service: the
*Slowest routes* panel names the route. Check CPU throttling (Kubernetes
dashboard) and, for Spring services, *DB connection pool in use*:
waiting connections mean pool exhaustion.

#### Alert: SentinelHighErrorRate
More than 5% of requests return 5xx. Service Detail → *5xx responses by
route*, then `kubectl logs -n sentinelcloud deploy/<job> | grep -i error`.
5xx at the gateway with healthy services = a downstream service is
unavailable (502).

#### Alert: SentinelHighCpu
Sustained > 85% of the CPU limit, so the container is being or will be
throttled. The HPA should already be adding replicas (Kubernetes
dashboard → *HPA: current vs desired*). If it's at `maxReplicas`, raise
it or the CPU limit (`k8s/base/apps/<svc>.yaml`). Node services also
raise `SentinelNodeEventLoopLag` when they're CPU-bound.

#### Alert: SentinelHighMemory
Above 90% of the memory limit; at 100% the kernel OOM-kills the pod.
Java: compare with *JVM heap used*. Heap close to 65% of the limit
(`MaxRAMPercentage`) means raise the limit. Node: a steadily climbing
RSS that never drops after GC suggests a leak.

#### Alert: SentinelPodCrashLooping
The container keeps exiting. `kubectl logs <pod> -n sentinelcloud --previous`
shows the last crash. `kubectl describe pod` shows the exit reason
(`OOMKilled`, `Error`). After a bad rollout:
`kubectl rollout undo deployment/<name> -n sentinelcloud`.

#### Alert: SentinelPodNotReady
Running but failing readiness, so no traffic is routed to it.
`kubectl describe pod` → *Readiness probe failed*.
`kubectl exec … -- wget -qO- localhost:<port>/health/ready` shows which
dependency it's missing.

#### Alert: SentinelHpaAtMaxReplicas
Informational. The autoscaler can't add more pods. Fine during a load
test; in real use, raise `maxReplicas` or the node size.

#### Alert: SentinelRabbitMQDown
The event bus is down: no disaster reactions and a silent live feed.
REST APIs keep working (the gateway no longer depends on the broker;
see §8). `kubectl get pods -n sentinelcloud -l app.kubernetes.io/name=rabbitmq`;
`kubectl logs statefulset/rabbitmq -n sentinelcloud`. Every service
reconnects automatically when it returns (Phase 9 reconnect logic).

#### Alert: SentinelQueueBacklog
Consumers are falling behind (backlog), or nobody is consuming (no
consumers). Event Bus dashboard → *Consumers per queue*: 0 means the
owning service is down or never registered its consumer. Scale it up,
or check its *Failed/rejected events*.

#### Alert: SentinelSlowEventProcessing
Publish → handled p95 above 5s. If *handler time* is also high, the
handler is slow (DB). If it's low, events are waiting in the queue
(backlog), so scale the consumer.

#### Alert: SentinelEventHandlerErrors
A consumer's handler is throwing, or receiving invalid JSON. Failed
events are dropped (no dead-letter queue), so those reactions are lost.
`kubectl logs deploy/<job> -n sentinelcloud | grep "handler for"`.

#### Alert: SentinelMonitoringTargetDown
Part of the monitoring stack isn't being scraped, so dashboards or
alerting are partly blind. `kubectl get pods -n sentinelcloud -l app.kubernetes.io/component=monitoring`.

---

## 4. Grafana dashboards

Four dashboards are provisioned into a **SentinelCloud** folder. They
are linked to each other through the *SentinelCloud dashboards* menu
(top right), and refresh every 15s. Colours follow the Command Center's
four tiers: green / yellow / orange / red. Every coloured tile also
shows its value or a word ("UP", "DOWN"), never colour alone.

| Dashboard | Purpose | Highlights |
|---|---|---|
| **SentinelCloud — System Health** (home page) | the whole platform on one screen | 12 status tiles (services up 8/8, critical alerts, warnings, request rate, 5xx %, p95, RabbitMQ, event latency, events/min, pods not ready, restarts, live clients) · service up/down timeline + availability % · dependency timeline · golden signals per service · CPU/memory (process and vs. limit) · event latency & queue depth · ready replicas & restarts · firing/pending alerts table |
| **SentinelCloud — Service Detail** | one service at a time (`$service` picker) | requests by route, responses by status class, p50/p95/p99, **latency heatmap**, slowest routes, 5xx by route, CPU/memory per instance, Node event-loop delay, JVM heap, DB pool, event latency/handler time, dependencies |
| **SentinelCloud — Kubernetes** | pods, restarts, limits, autoscaling | running/ready/not-ready/crash-looping/OOM tiles, pod status table, restarts per container, CPU & memory per service and vs. limit, CPU throttling, HPA current vs desired |
| **SentinelCloud — Event Bus** | RabbitMQ + publish/consume pipeline | broker status, connected/disconnected services, waiting & unacked messages, ready messages per queue, consumers per queue, publish/consume rates, end-to-end and handler latency, failed events |

Under Docker Compose the Kubernetes-only panels (pods, restarts,
limits, HPA) show *No data*; everything else works.

The dashboards are JSON in `k8s/base/monitoring/config/grafana/dashboards/`.
To change one: edit it in Grafana, then *Share → Export → Save to file*
over the JSON. Provisioned dashboards can't be saved from the UI, so
git stays the source of truth.

---

## 5. Running it

### Kubernetes (Kind)

The monitoring stack is part of the normal deployment: no extra
command. If your Kind cluster was created in Phase 9, **recreate it**
to get the new port mappings (30030/30090/30093), or skip the
recreation and use port-forwards (below).

```bash
# New keys for Grafana's login — add them to your existing secrets.env
# (Phase 12: ./scripts/generate-secrets.sh k8s adds them; Grafana no longer
# falls back to admin/admin — the key is required):
#   GRAFANA_ADMIN_USER=admin
#   GRAFANA_ADMIN_PASSWORD=<random, ≥16 chars>

kind delete cluster --name sentinelcloud                     # only if it exists from Phase 9
kind create cluster --config k8s/cluster/kind-cluster.yaml
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system --type=json --patch-file k8s/cluster/metrics-server-kind-patch.json
./scripts/k8s-build-images.sh kind                           # rebuild: services changed in this phase
kubectl apply -k k8s/overlays/local
kubectl wait --for=condition=Ready pods --all -n sentinelcloud --timeout=600s
```

| UI | Kind | Any cluster (port-forward) | Login |
|---|---|---|---|
| Grafana | http://localhost:30030 | `kubectl port-forward -n sentinelcloud svc/grafana 3000:3000` → :3000 | `admin` / `sentinel_grafana_dev` |
| Prometheus | http://localhost:30090 | `kubectl port-forward -n sentinelcloud svc/prometheus 9090:9090` | — |
| Alertmanager | http://localhost:30093 | `kubectl port-forward -n sentinelcloud svc/alertmanager 9093:9093` | — |

**Minikube:** `minikube service grafana -n sentinelcloud --url` (likewise
`prometheus`, `alertmanager`), or the port-forwards.

Quick health check from the CLI:

```bash
kubectl get pods -n sentinelcloud -l app.kubernetes.io/component=monitoring
kubectl exec -n sentinelcloud deploy/prometheus -- wget -qO- localhost:9090/api/v1/targets | head -c 300
```

In Prometheus → *Status → Targets*, expect `sentinelcloud-pods` (one
target per service pod: scale a service and watch new targets appear),
`kubernetes-cadvisor`, `kube-state-metrics`, `rabbitmq`,
`rabbitmq-queues`, `prometheus`, `alertmanager` and `grafana`, all `UP`.

### Docker Compose

```bash
docker compose up --build -d
```

Grafana http://localhost:3000 (`GRAFANA_ADMIN_*` from `.env`, generated — Phase 12),
Prometheus http://localhost:9090, Alertmanager http://localhost:9093.

### Changing rules or dashboards

Edit the files in `k8s/base/monitoring/config/`, then:

```bash
promtool check rules k8s/base/monitoring/config/prometheus/rules/*.yml          # syntax
promtool test rules  k8s/base/monitoring/config/prometheus/tests/alerts.test.yml # behaviour
kubectl apply -k k8s/overlays/local                                              # rolls Prometheus/Grafana
# Compose: curl -X POST localhost:9090/-/reload   (or restart grafana for dashboards)
```

(`promtool` ships inside the Prometheus image:
`docker run --rm -v "$PWD:/w" -w /w --entrypoint promtool prom/prometheus:v2.54.1 test rules k8s/base/monitoring/config/prometheus/tests/alerts.test.yml`.)

---

## 6. Presentation demo — monitoring in ~12 minutes

The narrative: **"We can see everything, we see problems before users
report them, and one root cause produces one alert, not ten."** Every
step uses real behaviour of the system, with no fake data.

### Before the presentation (T−15 min)

```bash
kubectl get pods -n sentinelcloud                       # everything 1/1 Running
kubectl scale deployment traffic-generator -n sentinelcloud --replicas=1   # realistic API traffic, read-only
```

The traffic generator (`k8s/base/demo/traffic-generator.yaml`, deployed
at 0 replicas) logs in through the gateway and calls every domain
service ~8 times/second. Start it **at least 5 minutes early**, because
rates and percentiles use 5-minute windows. Then open these browser tabs:

1. Grafana → **SentinelCloud — System Health**. Time range *Last 15 minutes*, refresh *10s*.
2. Grafana → **SentinelCloud — Event Bus**.
3. Grafana → **SentinelCloud — Kubernetes**.
4. Prometheus → **Alerts** (http://localhost:30090/alerts).
5. Alertmanager (http://localhost:30093).
6. SentinelCloud frontend (http://localhost:30080), logged in, on the live emergency dashboard.

Keep a terminal open with `kubectl get pods -n sentinelcloud -w`.

### Act 1: everything healthy (1 min) — tab 1

Walk the top row: **8/8 services up**, 0 critical alerts, real request
rate, error rate ~0%, p95 in milliseconds, RabbitMQ UP. Point out the
availability timeline and the per-service golden-signal graphs.

> "Every service exposes the same metrics. Node and Java emit identical
> names, so one query covers all eight."

### Act 2: the event pipeline (2 min) — tabs 6 → 2

Create a disaster in the frontend. Switch to **Event Bus**: *Published*
jumps, four consumer queues process it, and **end-to-end latency p95**
is milliseconds.

> "This is measured from the disaster service's publish timestamp to
> each consumer finishing: event-processing latency across services."

### Act 3: autoscaling under load (3 min) — tab 3

```bash
kubectl run loadgen -n sentinelcloud --image=busybox:1.36 --restart=Never -- /bin/sh -c "for i in 1 2 3 4 5 6; do (while true; do wget -q -O /dev/null http://ambulance-service:8083/health/ready; done) & done; wait"
```

Watch *CPU used / limit* climb, *HPA current vs desired* step up
(desired first, current follows), and *Ready replicas per deployment*
rise. In Prometheus → *Status → Targets*, the new ambulance-service
pods appear on their own: service discovery. If you leave it running,
`SentinelHighCpu` shows as **pending** in tab 4, which is a good moment
to explain `for: 5m`.

```bash
kubectl delete pod loadgen -n sentinelcloud      # stop; the HPA scales back down over a few minutes
```

### Act 4: message broker failure (3 min) — tabs 1, 4, 5

> **Phase 11:** the *Message broker failure* drill on the Resilience Demo page
> runs this act automatically (queue buildup, broker loss, recovery, 0 events
> lost) — run it while this Grafana view is open. See
> [`PHASE-11-RESILIENCE.md`](PHASE-11-RESILIENCE.md).

```bash
kubectl scale statefulset rabbitmq -n sentinelcloud --replicas=0
```

| Time | What to show |
|---|---|
| ~15s | System Health: **RabbitMQ tile turns red (DOWN)**; Dependencies timeline: services lose `rabbitmq` |
| ~30s | Prometheus *Alerts*: `SentinelRabbitMQDown` **PENDING** |
| ~1m15s | `SentinelRabbitMQDown` **FIRING**; it appears in Alertmanager and in the dashboard's *Critical alerts* tile |
| ~2m15s | `SentinelServiceLostBrokerConnection` fires in Prometheus, but in Alertmanager it's **suppressed** (inhibited) |

> "Seven services lost their broker connection, but we get one
> notification: the root cause. And the REST API keeps working: the
> frontend still loads hospitals. Only the event-driven parts are down."

Restore:

```bash
kubectl scale statefulset rabbitmq -n sentinelcloud --replicas=1
```

Within ~1 minute RabbitMQ is back, every service **reconnects on its
own** and re-registers its consumers, and the alerts **resolve**.

### Act 5: a bad deployment → crash loop (3 min) — tabs 1, 3, 4

Simulate a broken release by removing the gateway's JWT secret, which
it refuses to start without:

```bash
kubectl set env deployment/gateway -n sentinelcloud JWT_ACCESS_SECRET-
kubectl get pods -n sentinelcloud -l app.kubernetes.io/name=gateway -w
```

The new pod goes `Error → CrashLoopBackOff`. After ~1–2 minutes,
`SentinelPodCrashLooping` fires and the Kubernetes dashboard shows the
restarts climbing.

> "But look at System Health: still **8/8 up**, and the frontend still
> works. The rolling update (`maxUnavailable: 0`) kept the old pod
> serving. The monitoring caught a bad release before any user did."

```bash
kubectl rollout undo deployment/gateway -n sentinelcloud
```

The alert resolves once the bad pod is gone.

### Optional extras

- **Silence an alert:** in Alertmanager click *Silence* on a firing
  alert, which is what an on-call engineer does during planned
  maintenance.
- **Prove the thresholds:**
  `promtool test rules k8s/base/monitoring/config/prometheus/tests/alerts.test.yml`
  runs 19 alert tests in under a second.
- **Database outage** (slower, more dramatic):
  `kubectl scale statefulset postgres -n sentinelcloud --replicas=0`.
  `SentinelDependencyUnreachable` and `SentinelDeploymentUnavailable`
  fire for the six DB-backed services after ~2 minutes. Restore with
  `--replicas=1`.

### After the demo

```bash
kubectl scale deployment traffic-generator -n sentinelcloud --replicas=0
```

### If something doesn't cooperate live

| Problem | Fix |
|---|---|
| Graphs flat / "No data" right after deploy | rates need a few minutes of samples; that's why the traffic generator starts 15 min early |
| An alert seems slow to fire | `for:` + the 15s scrape and evaluation interval: `RabbitMQDown` needs ~1m15s, `PodCrashLooping` ~1.5–2m. Show the PENDING state meanwhile; it's part of the story |
| Grafana tiles show *No data* for pods/restarts | kube-state-metrics not ready: `kubectl get pods -n sentinelcloud -l app.kubernetes.io/name=kube-state-metrics` |
| Prometheus pod `Pending` after a load test | the HPA's extra replicas used the node's CPU requests; delete the load generator and wait for scale-down (see §10) |

---

## 7. Resource cost

| Component | CPU request | Memory request | Limit (CPU / mem) |
|---|---|---|---|
| Prometheus | 100m | 256Mi | 1 / 1Gi (PVC 2Gi, retention 3 days / 1.5 GB) |
| Grafana | 50m | 128Mi | 500m / 384Mi |
| Alertmanager | 10m | 32Mi | 200m / 128Mi |
| kube-state-metrics | 10m | 32Mi | 200m / 128Mi |
| **Total added** | **170m** | **448Mi** | |

The whole system now requests ~1.65 CPU and ~3 GiB, so the Phase 9
advice of **4 CPUs and 6 GiB** for Docker or Minikube still holds. With
everything running, the in-cluster Prometheus held only **~2,000
active series**. cAdvisor is filtered down to the 6 metrics actually
used, and kube-state-metrics to the SentinelCloud namespace and the 9
object kinds the dashboards use.

---

## 8. Code changes in this phase

| Change | Where |
|---|---|
| `metrics.js` + 12 unit tests in every Node service; `/metrics` route; HTTP middleware; dependency gauges | `services/*/src/metrics.js`, `index.js`, `tests/metrics.test.js` |
| Event instrumentation: consumed/published counters, end-to-end + handler latency | Node `src/broker.js`; Spring `event/EventMetrics.java`, `DisasterEventListener`, `EventPublisher` |
| Spring: identical HTTP buckets; `process_cpu_seconds_total`, `process_resident_memory_bytes`, Postgres dependency gauge | `application.yml`, `config/ObservabilityMetrics.java` |
| **Gateway readiness no longer requires RabbitMQ.** Before, a broker outage marked every gateway pod unready and took the whole API offline, even though the gateway publishes nothing. Found while scripting the broker-failure demo | `services/gateway/src/index.js` |
| Prometheus scrape path for Spring fixed: `/prometheus` (Phase 1 had `/actuator/prometheus`, which never matched the `/` actuator base path) | `infrastructure/prometheus/prometheus.yml` |
| RabbitMQ: `rabbitmq_prometheus` plugin enabled explicitly, port 15692 | `k8s/base/infrastructure/rabbitmq.yaml`, `docker-compose.yml` |
| Pod scrape annotations on all 8 services | `k8s/base/apps/*.yaml` |
| Demo traffic generator (0 replicas by default) | `k8s/base/demo/traffic-generator.yaml` |
| notification-service gained a `test` script and test folder | `services/notification-service/package.json` |

---

## 9. Verification performed for this phase

The sandbox this was built in can't pull images from Docker Hub,
registry.k8s.io, npm or Maven. It **can** download Prometheus and
Alertmanager release binaries, and it had a working k3s cluster. Here
is exactly what was verified:

| Check | How | Result |
|---|---|---|
| Metrics module | 12 `node:test` tests × 6 services; `promtool check metrics` on a full scrape | ✅ all pass; lint-clean (it caught a `quantile` label misuse, now fixed) |
| Rules & configs | `promtool check rules`, `promtool check config` (both scrape configs), `amtool check-config` | ✅ |
| **Every alert's behaviour** | `promtool test rules`: 19 tests with exact expected labels and rendered annotations, "must not fire" cases (healthy services, probe traffic, low-traffic noise, scale-to-zero) and `for:` timing | ✅ all pass |
| **Live pipeline** | real Prometheus + Alertmanager binaries; 8 processes running the **real `metrics.js`** under HTTP load with simulated events; fake kube-state-metrics/cAdvisor/RabbitMQ endpoints; then faults injected | ✅ 14 of 19 alerts fired for real, with values matching the faults (e.g. 27.9% errors for 30% injected; 96% of memory limit); both inhibition rules suppressed correctly |
| **Every dashboard query** | all 81 panel queries run against that Prometheus | ✅ 0 errors; 76 returned data (the rest correctly empty: JVM/HikariCP only exist on real Spring apps) |
| **In-cluster on Kubernetes** | real Prometheus and Alertmanager images (from the release binaries) deployed with the actual manifests on k3s; app pods running the real `metrics.js` | ✅ RBAC + pod discovery (8 services, `job` = service, one target per pod, Spring on `/prometheus`); HPA-added pods discovered automatically; cAdvisor via the API proxy; per-service CPU/memory for all 16 workloads; an alert fired end to end in-cluster; all 81 dashboard queries ran with 0 errors; 70 manifests accepted by `--dry-run=server` |
| Inhibition rules | synthetic alerts posted to a live Alertmanager | ✅ broker side-effects suppressed; unrelated outage stayed active |
| Demo traffic generator | its script run under busybox, uid 65534, read-only FS, against a fake gateway | ✅ correct login JSON, token extraction, Bearer header on all 8 paths |
| Docker Compose | `docker compose config` | ✅ valid |
| Java changes | parsed with `javac` | ⚠️ not compiled against Spring/Micrometer (Maven blocked). Run `mvn -B test` in both Spring services |
| Grafana | dashboards linted (unique ids, no overlapping/overflowing panels, datasource refs) and every query validated | ⚠️ Grafana itself couldn't be run here. The first `kubectl apply` is its first real load |
| kube-state-metrics, RabbitMQ plugin output | metric names from upstream docs, exercised with correctly-shaped fakes | ⚠️ not run against the real exporters |

**Bugs the live testing caught** (all fixed, and kept from coming back
by the unit tests):
1. Kubernetes alerts inherited `job="kube-state-metrics"`, which would
   mislabel notifications and break per-service grouping. Now `job` =
   the service.
2. The cAdvisor rules assumed per-container series, which some runtimes
   don't produce. Switched to pod-level series, which every kubelet
   reports.
3. A PromQL `on (…)` match was silently dropping the `job` label; fixed
   with `group_left`.

---

## 10. Likely errors and fixes

| Symptom | Cause | Fix |
|---|---|---|
| Grafana login fails with your password | `secrets.env` predates this phase | run `./scripts/generate-secrets.sh k8s` (adds `GRAFANA_ADMIN_*`), then re-apply |
| `localhost:30030` not reachable on Kind | cluster created before this phase (port mappings are fixed at creation) | recreate the cluster, or use the port-forwards in §5 |
| Prometheus target `kubernetes-cadvisor` DOWN, 403 | ClusterRole missing (applied piecemeal) | `kubectl apply -k k8s/overlays/local` |
| `sentinelcloud-pods` shows no targets | images from Phase 9 (no `/metrics`) or pods lack annotations | rebuild images (`./scripts/k8s-build-images.sh kind`) and re-apply |
| Spring targets DOWN with 404 | old scrape path `/actuator/prometheus` | this phase's config uses `/prometheus`; re-apply |
| `rabbitmq` target DOWN, connection refused | plugin not enabled (the RabbitMQ pod predates the `enabled_plugins` mount) | `kubectl rollout restart statefulset/rabbitmq -n sentinelcloud` |
| Pods/restarts panels *No data* | kube-state-metrics not running, or Docker Compose (no Kubernetes data by design) | `kubectl logs deploy/kube-state-metrics -n sentinelcloud` |
| Prometheus `Pending: Insufficient cpu` | HPA scale-outs used the node's spare CPU requests (observed during testing on a 2-CPU node) | give the cluster 4 CPUs; stop load generators; the HPA scales down within minutes |
| Event latency looks negative/odd across machines | `occurredAt` uses the publisher's clock | single-node clusters share a clock; multi-node relies on NTP (values < 0 are clamped to 0) |
| `kubectl apply` error: annotation too long on `grafana-dashboards` | dashboards grew past ~256KB (they're 152KB now) | `kubectl apply -k k8s/overlays/local --server-side` |

---

## 11. Known limitations

- **Structured JSON logs with correlation IDs, and log aggregation
  (Loki)** from `ARCHITECTURE.md` §9 are not part of this phase. This
  phase covers metrics and alerting; logs remain `kubectl logs`.
- **No tracing** (OpenTelemetry/Jaeger). Event latency is measured from
  timestamps, not trace spans.
- **Single Prometheus, no long-term storage.** Fine for a local
  cluster. Production would add HA pairs or Thanos/Mimir.
- **Alertmanager ships with no notification channel** (no paid service
  or secrets required). Add one receiver block to get email/Slack/webhooks.
- **Monitoring shares the namespace and node with the app.** A real
  setup would use its own namespace and a higher PriorityClass, so app
  scale-outs can never starve it (see the *Pending* row in §10).
