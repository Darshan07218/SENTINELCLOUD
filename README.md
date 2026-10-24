# SentinelCloud

**Cloud-Native Critical Infrastructure Intelligence & Emergency Response Platform**
*Individual Third-Year Cloud Computing Project*

> **Build status: Phase 13 — Engineering review complete.**
> All 12 build phases are in place (auth, hospitals, ambulances, blood
> banks, power, disasters + event bus, live feed, Command Center,
> Kubernetes, monitoring, Resilience Demo, security hardening). Phase 13
> audited the whole system, fixed the defects it found (dispatch races,
> failure-event bookkeeping, double-crediting blood releases, broker
> crash paths, responsive UI…) and added a real-PostgreSQL integration
> suite and a one-command verifier. Start with
> [`docs/SYSTEM-REFERENCE.md`](docs/SYSTEM-REFERENCE.md) (architecture,
> APIs, schemas, setup, demo) and
> [`docs/ENGINEERING-REVIEW.md`](docs/ENGINEERING-REVIEW.md) (what was
> found, fixed and verified). Security: [`SECURITY.md`](SECURITY.md).

---

## What this repository is

SentinelCloud simulates how hospitals, ambulance services, blood banks,
and power infrastructure coordinate during a disaster, via an
event-driven microservices architecture. Full system design lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). This README covers only
what's needed to run and verify what exists today.

## Repository layout

```
sentinelcloud/
├── SECURITY.md                  # security architecture (Phase 12)
├── docker-compose.yml          # orchestrates the entire local stack
├── .env.example                 # template; ./scripts/generate-secrets.sh creates .env
├── k8s/                         # Kubernetes (Phase 9): base/ + overlays/local/ — kubectl apply -k k8s/overlays/local
├── scripts/k8s-build-images.sh  # builds all images for Kind/Minikube
├── scripts/generate-secrets.sh  # random secrets for .env and k8s secrets.env (Phase 12)
├── scripts/verify-system.sh     # the 13 end-to-end checks against Compose and/or Kind
├── scripts/run-node-tests.sh    # every Node test file, pass/fail per file
├── tests/db/                    # real-PostgreSQL integration suite (all services' migrations + data logic)
├── shared/node-security/        # canonical security modules copied into each Node service
├── frontend/                    # React + Vite dashboard (Dockerfile = nginx prod, Dockerfile.dev = Compose)
├── services/
│   ├── gateway/                 # API Gateway (Node/Express) — single ingress
│   ├── auth-service/            # Node/Express — users/JWT (Phase 2)
│   ├── hospital-service/        # Node/Express
│   ├── ambulance-service/       # Node/Express
│   ├── disaster-service/        # Node/Express — event orchestrator
│   ├── notification-service/    # Node/Express + WebSocket + Redis
│   ├── resilience-service/      # Node (no deps) — failure drills for the Resilience Demo (Phase 11)
│   ├── blood-bank-service/      # Spring Boot (Java 21)
│   └── power-service/           # Spring Boot (Java 21)
├── infrastructure/
│   ├── postgres-init/           # multi-database bootstrap script
│   └── prometheus/              # Compose scrape config (rules/dashboards: k8s/base/monitoring/config/)
└── docs/
    ├── SYSTEM-REFERENCE.md      # architecture, tree, stack, APIs, schemas, setup, demo, limits
    ├── ENGINEERING-REVIEW.md    # Phase 13 audit: findings, fixes, verification evidence
    ├── EVENT-SCHEMA.md          # every routing key and payload on the event bus
    ├── ARCHITECTURE.md          # design rationale (historical; current facts in SYSTEM-REFERENCE)
    ├── ROADMAP.md
    ├── PHASE-1-FOUNDATION.md    # what was built, how to verify it
    ├── …                        # one doc per phase
    ├── PHASE-9-KUBERNETES.md    # cluster setup, scaling demo, probes, limits
    ├── PHASE-10-MONITORING.md   # metrics, dashboards, alerts, presentation demo
    └── PHASE-11-RESILIENCE.md   # failure drills, self-healing demo, presentation script
```

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin) — v24+
- ~4 GB free RAM for the stack (single shared Postgres instance is used
  locally specifically to keep this light — see `docs/ARCHITECTURE.md`)
- No cloud account of any kind is required. Everything above runs
  entirely on your machine, for free.

## Quick start

```bash
# 1. Clone/enter the repo, then generate .env with random secrets
#    (Phase 12; Windows: run it in Git Bash or WSL)
./scripts/generate-secrets.sh compose

# 2. Build and start every container
docker compose up --build

# First run: Postgres/RabbitMQ images download, Maven compiles the two
# Spring Boot services from scratch, and npm installs each Node
# service's dependencies inside its build stage. Expect this to take
# several minutes the first time; subsequent runs are much faster due
# to Docker layer caching.
```

When it's ready, open:

- **Frontend (Command Center and dashboards):** http://localhost:5173
- **API Gateway:** http://localhost:8080/health
- **RabbitMQ management UI:** http://localhost:15672 (user/pass from `.env`)
- **Prometheus:** http://localhost:9090
- **Grafana:** http://localhost:3000 (`GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` from `.env`)

Every port is bound to 127.0.0.1 (this computer only), and the application
services aren't published at all: the gateway is the single way in. See
[`SECURITY.md`](SECURITY.md).

To check the whole system end to end (13 checks, pass/fail each):

```bash
./scripts/verify-system.sh compose --yes   # starts from clean volumes
```

## Authentication

Register and log in via the frontend at http://localhost:5173, or directly:

```bash
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SomeStrongPass1","fullName":"Your Name"}'

curl -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SomeStrongPass1"}'
```

Sign-up always creates a read-only `CITIZEN` account (Phase 12). A
`SYSTEM_ADMIN` grants other roles on the **Users** page (or
`PATCH /api/v1/auth/users/{id}`). The first `SYSTEM_ADMIN` is seeded on
first startup from `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` in
`.env` — the generator creates a random password; read it from that file.
Interactive API docs: http://localhost:8080/api/v1/auth/docs (the only
public docs page). The other services' Swagger pages sit behind the gateway's
authentication, so a browser gets 401 there; use the API list in
[`docs/SYSTEM-REFERENCE.md`](docs/SYSTEM-REFERENCE.md#4-api-list) or call them
with a token. Older walkthrough in [`docs/PHASE-2-AUTH.md`](docs/PHASE-2-AUTH.md).

## Hospitals

8 realistic sample hospitals are seeded automatically on first
startup. Log in and click **Hospitals** in the nav for a live
dashboard (total hospitals, bed/ICU availability, overloaded count,
capacity %, and an alerts feed). Full API — register a hospital,
update bed/ICU/ventilator availability, search near a location, mark a
hospital overloaded — in [`docs/PHASE-3-HOSPITAL.md`](docs/PHASE-3-HOSPITAL.md)
(Swagger at `/api/v1/hospitals/docs` needs a Bearer token).

## Ambulances & Dispatch

10 sample ambulances and 1 demo emergency are seeded automatically.
Log in and click **Ambulances** for a live fleet map (color-coded by
status) and active-emergency feed. Report an emergency via the API and
watch the full dispatch workflow run in one call — find available
ambulances, rank by realistic road distance, assign the best one, and
publish an event. Dispatch is transactional: two operators can never send
the same ambulance to two calls, and cancelling a call frees its
ambulance. Documented in [`docs/PHASE-4-AMBULANCE.md`](docs/PHASE-4-AMBULANCE.md).

## Blood Banks

3 sample blood banks with a deliberately uneven inventory spread (some
healthy, some low, some expiring soon) are seeded automatically, along
with synthetic historical demand data. Log in and click **Blood
Banks** for inventory/low-stock/expiry charts, a demand trend chart
with a prototype forecast, and a shortage-alert feed. **The demand
forecast is a simple statistical prototype over synthetic demo data —
it is not medically validated and should never be used for real
clinical or procurement decisions** (the API repeats this disclaimer
on every response). Full API — add inventory, reserve/release blood,
transfer between banks — documented in
[`docs/PHASE-5-BLOOD-BANK.md`](docs/PHASE-5-BLOOD-BANK.md).

## Power Grid

Substations and transformers with live telemetry: each reading is checked
against the transformer's rated values and its own statistical baseline;
CRITICAL/FAILED transitions open a failure episode that recovery closes.
Click **Power Grid** for the map, overloaded/high-temperature lists and
telemetry trends. Details: [`docs/PHASE-6-POWER.md`](docs/PHASE-6-POWER.md).

## Disasters and the event bus

An `EMERGENCY_OPERATOR` reports a disaster on the **Emergency** page; it is
published as `disaster.detected` on RabbitMQ, the hospital, ambulance,
blood-bank and power services each answer with a reaction event, and the
disaster service assembles them into a live situation report. Status moves
ACTIVE ⇄ CONTAINED → RESOLVED (RESOLVED is final). Event contract:
[`docs/EVENT-SCHEMA.md`](docs/EVENT-SCHEMA.md); walkthrough:
[`docs/PHASE-7-DISASTER.md`](docs/PHASE-7-DISASTER.md).

## Command Center

The home page after login: one view of every domain (map, alerts, KPIs,
event timeline) that refreshes itself when events arrive. Details:
[`docs/PHASE-8-COMMAND-CENTER.md`](docs/PHASE-8-COMMAND-CENTER.md).

## Reliable events (Phase 14)

No event is lost any more, even when RabbitMQ is down or a handler fails.
A change and its event are saved in one database transaction (the
**outbox**) and delivered once RabbitMQ confirms it; a failing handler is
retried, then its message is parked in a **dead-letter queue** instead of
dropped. SYSTEM_ADMINs list and replay dead letters at
`GET`/`POST /api/v1/notifications/dead-letters[/replay]`; Grafana's System
Health has an "Event reliability" row, with two new alerts. Details, runbooks
and the outage demo: [`docs/PHASE-14-RELIABLE-EVENTS.md`](docs/PHASE-14-RELIABLE-EVENTS.md).

## Automated response engine (Phase 15)

A ninth microservice, **response-service**, turns each disaster's
situation report into a **response plan**: dispatch the right number of
ambulances, reserve O− and O+ blood at the nearest bank for the nearest
hospital with free beds, widen the search when too few ambulances are in
range, and flag what only a person can do (ICU shortages, transformers at
risk). The plan appears on the **Emergency** page under the situation
report; an EMERGENCY_OPERATOR approves or rejects it, and can **undo** it
afterwards (calls cancelled, ambulances freed, blood released). Plans are
carried out through command events, each executed exactly once by the
service that owns the resource. Set `RESPONSE_AUTO_APPROVE=true` to execute
plans without waiting. Details: [`docs/PHASE-15-RESPONSE-ENGINE.md`](docs/PHASE-15-RESPONSE-ENGINE.md).
The playbook is a demo policy, not emergency-management guidance.

## Scenario simulator (Phase 16)

For a hands-free demo, a SYSTEM_ADMIN opens **Simulator** and starts a
scripted disaster (monsoon flood, earthquake with escalation, industrial
fire). It plays out over 2–4 minutes on its own: the disaster is reported,
hospitals fill up, a transformer overheats, the response plan is approved,
ambulances drive to the scene and back on the map, and everything is restored
and resolved at the end. The page shows each step's narration next to what
actually happened. A **background** switch keeps the city alive between demos
(ambulances finish their calls, transformers report readings).

**simulator-service** acts only through the API gateway, with its own service
account (`SIMULATOR_EMAIL` / `SIMULATOR_PASSWORD`), so every step passes the
same checks and audit log as a person's click. Details:
[`docs/PHASE-16-SIMULATOR.md`](docs/PHASE-16-SIMULATOR.md).

## CI and queue-based autoscaling (Phase 17)

**CI:** `.github/workflows/ci.yml` runs on every push and pull request: Node
tests, the real-PostgreSQL suite, Java tests, alert unit tests, Compose and
Kubernetes manifest checks, and a build of every Docker image. The full
13-check system verification runs nightly and on demand. It starts working
as soon as the project is pushed to GitHub.

**KEDA:** on Kubernetes, notification-service also scales on its **backlog**:
one replica per 20 events waiting in its queue (1–3 replicas), on top of
CPU. `scripts/k8s-desktop.ps1 deploy` installs KEDA and uses
`k8s/overlays/local-keda`; `k8s/overlays/local` still works without it.
`.\scripts\keda-scale-demo.ps1` shows it scaling 1 → 3 replicas on a
synthetic backlog. Details: [`docs/PHASE-17-CI-AND-KEDA.md`](docs/PHASE-17-CI-AND-KEDA.md).

## Maps and forecasts (Phase 18)

Every map is a real tiled map (Leaflet, OpenStreetMap data). On top of that:

- **Bed-occupancy forecast** (Hospitals page): every change to a hospital's
  beds or ICU is recorded (a database trigger), and the next 24 h of
  occupancy is forecast from the last 7 days, with an 80% band, the hours
  until the 90% "full" line and a risk level. A map colours each hospital by
  that risk. API: `GET /api/v1/hospitals/forecast`, `GET /api/v1/hospitals/{id}/forecast`.
- **Transformer-risk forecast** (Power page): each transformer's load and
  temperature trend, projected against its critical limits, plus its recent
  failures and anomalies, as a 0–100 score with the reasons. API:
  `GET /api/v1/power/transformers/risk-forecast`, `…/transformers/{id}/risk-forecast`.

A fresh install gets 72 h of synthetic hospital history so the forecast has
something to show; it is marked as such in the API and on the page.
Details: [`docs/PHASE-18-MAPS-AND-FORECASTS.md`](docs/PHASE-18-MAPS-AND-FORECASTS.md).

## Stopping the stack

```bash
docker compose down          # stop and remove containers, keep data volumes
docker compose down -v       # also wipe Postgres/Redis/RabbitMQ/Grafana/Prometheus data
```

## Running on Kubernetes (Phase 9)

Free and fully local: Kind or Minikube, no cloud account. Short version
with Kind (full walkthrough, Minikube commands, the scaling demo and
troubleshooting are in [`docs/PHASE-9-KUBERNETES.md`](docs/PHASE-9-KUBERNETES.md)):

```bash
kind create cluster --config k8s/cluster/kind-cluster.yaml
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system --type=json --patch-file k8s/cluster/metrics-server-kind-patch.json
./scripts/k8s-build-images.sh kind          # builds 10 images + loads them into Kind
./scripts/generate-secrets.sh k8s           # random secrets → k8s/overlays/local/secrets.env
# server-side: the Grafana dashboards ConfigMap exceeds client-side apply's annotation limit
kubectl apply --server-side -k k8s/overlays/local
kubectl wait --for=condition=Ready pods --all -n sentinelcloud --timeout=600s
# open http://localhost:30080

kubectl scale deployment hospital-service --replicas=3 -n sentinelcloud   # scaling demo
kubectl delete -k k8s/overlays/local                                                    # remove everything
kind delete cluster --name sentinelcloud
```

Give Docker at least 4 CPUs and 6 GiB of RAM.

## Monitoring (Phase 10)

Deployed automatically with the rest of the stack, in both Kubernetes
and Docker Compose. Full details, every alert's runbook, and a
step-by-step **presentation demo script** are in
[`docs/PHASE-10-MONITORING.md`](docs/PHASE-10-MONITORING.md).

| UI | Kubernetes (Kind) | Docker Compose | Login |
|---|---|---|---|
| Grafana (System Health dashboard) | http://localhost:30030 | http://localhost:3000 | admin / `GRAFANA_ADMIN_PASSWORD` |
| Prometheus (targets, alerts) | http://localhost:30090 | http://localhost:9090 | — |
| Alertmanager | http://localhost:30093 | http://localhost:9093 | — |

```bash
promtool test rules k8s/base/monitoring/config/prometheus/tests/alerts.test.yml   # 19 alert unit tests
kubectl scale deployment traffic-generator -n sentinelcloud --replicas=1         # demo traffic (read-only)
```

## Resilience Demo (Phase 11)

Kubernetes only (under Docker Compose the page explains why drills need an
orchestrator). Full details, the security model and a **presentation
script** are in [`docs/PHASE-11-RESILIENCE.md`](docs/PHASE-11-RESILIENCE.md).

`./scripts/generate-secrets.sh k8s` already creates the shared
`RESILIENCE_CHAOS_TOKEN` the drills need. Open http://localhost:30080, log in
as a `SYSTEM_ADMIN` and choose **Resilience Demo**.

| Drill | Shows |
|---|---|
| Hospital service failure (pod hangs) | readiness probe → load balancer removes it; liveness probe → restart |
| Ambulance service failure (process crash) | kubelet restart, failover to the other replica |
| Blood service failure (Spring `LivenessState.BROKEN`) | actuator health groups → probes → JVM restart |
| Power service failure (pod lost) | ReplicaSet creates a replacement pod |
| High emergency traffic | HorizontalPodAutoscaler scale-out + load spreading |
| Message broker failure | queue buildup, StatefulSet + PVC broker recovery, reconnects, 0 events lost |

## Tests

```bash
./scripts/run-node-tests.sh          # every Node test file (run npm ci in each service first)
.\scripts\run-node-tests.ps1         # the same on Windows PowerShell
(cd services/blood-bank-service && mvn test); (cd services/power-service && mvn test)
promtool test rules k8s/base/monitoring/config/prometheus/tests/alerts.test.yml
# real PostgreSQL (wipes the six service databases — see the file header):
SC_DB_TEST=1 SC_DB_TEST_ALLOW_RESET=1 PGHOST=127.0.0.1 PGPORT=5432 … node --test tests/db/realPostgres.test.js
```

`./scripts/verify-system.sh` runs all of these (in containers) plus the 13
system checks. Details: [`docs/SYSTEM-REFERENCE.md`](docs/SYSTEM-REFERENCE.md#12-testing).

## Development without Docker (per-service)

Each service also has its own `.env.example` for running it directly
with `npm run dev` (Node services) or `mvn spring-boot:run` (Spring
services) against infra started via `docker compose up postgres redis
rabbitmq`. See the service's own directory for specifics — this is
optional; Docker Compose is the primary supported workflow.

## License / academic context

This is coursework for an individual third-year Cloud Computing module.
No production data, real infrastructure, or real emergency-service
integration is used or intended.
