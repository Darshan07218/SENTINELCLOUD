# SentinelCloud — System Reference

The system **as built and verified** after the Phase 13 engineering review.
Design rationale lives in the per-phase docs; what was found and fixed in
the review is in [`ENGINEERING-REVIEW.md`](ENGINEERING-REVIEW.md).

Contents: [1 Architecture](#1-final-architecture) ·
[2 Directory tree](#2-directory-tree) · [3 Technology stack](#3-technology-stack) ·
[4 API list](#4-api-list) · [5 Database schema](#5-database-schema) ·
[6 Event schema](#6-event-schema) · [7 Docker](#7-docker-architecture) ·
[8 Kubernetes](#8-kubernetes-architecture) · [9 Monitoring](#9-monitoring-architecture) ·
[10 Security](#10-security-architecture) · [11 Setup](#11-setup-instructions) ·
[12 Testing](#12-testing) · [13 Demonstration](#13-demonstration-procedure) ·
[14 Known limitations](#14-known-limitations)

---

## 1. Final architecture

```
                    Browser (React SPA: Command Center, dashboards, Users, Resilience Demo)
                        │  HTTPS/HTTP  /api/v1/*  ·  WebSocket /ws/live (bearer sub-protocol)
                        ▼
      ┌──────────────────────────────────────────────────────────────────────┐
      │ Kubernetes: frontend nginx (CSP, SPA) ── /api,/ws,/health ─┐          │
      │ Compose:    Vite dev server (5173)        browser → :8080  │          │
      └────────────────────────────────────────────────────────────┼──────────┘
                                                                   ▼
   ┌────────────────────────────── API Gateway (Node/Express) ───────────────────────────────┐
   │ path guard → per-IP rate limit → JWT (HS256) → fail-closed role table → per-user write    │
   │ limit → audit log → reverse proxy (strips /api/v1/<svc>) ; WS: origin + token + 30/min/IP │
   │ /health/services: readiness of all 8 services, cached 5 s                                 │
   └──┬──────────┬───────────┬────────────┬────────────┬───────────┬────────────┬────────────┬┘
      ▼          ▼           ▼            ▼            ▼           ▼            ▼            ▼
   auth       hospital    ambulance   blood-bank     power      disaster   notification  resilience
   (Node)     (Node)      (Node)      (Spring)       (Spring)   (Node)     (Node+WS)     (Node, 0 deps)
     │           │           │            │             │          │   ▲        │   ▲         │
     │           │           │            │             │          │   │        │   │         └─ Kubernetes API
     ▼           ▼           ▼            ▼             ▼          ▼   │        ▼   │            (least-privilege
   ┌──────────────── PostgreSQL 16: one database + one login role per service ─────┐ Redis      RBAC) + RabbitMQ
   │ auth_db · hospital_db · ambulance_db · blood_db · power_db · disaster_db       │ (recent    management API
   └────────────────────────────────────────────────────────────────────────────────┘ events)
                         ▲ publish / consume
   ┌─────────────────────┴──────── RabbitMQ topic exchange  sentinelcloud.events ───────────────────────┐
   │ disaster.detected/updated ─► hospital, ambulance, blood, power ─► 4 reaction events ─► disaster     │
   │ (fan-out)                                                          (fan-in: situation report)       │
   │ "#" ─► notification-service ─► Redis history + WebSocket broadcast to every browser                 │
   └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
   Prometheus ◄─ /metrics (Node) · /prometheus (Spring) · RabbitMQ · cAdvisor · kube-state-metrics
        └─► 15 recording + 19 alert rules ─► Alertmanager      Grafana: 4 provisioned dashboards
```

**Request path.** Browser → gateway (`/api/v1/<service>/…`) → service. Every
service re-verifies the JWT itself (defence in depth) and enforces
fine-grained rules (hospital ownership, reservation release rights).

**Event path (the core scenario).** An operator reports a disaster →
disaster-service stores it and publishes `disaster.detected` → hospital,
ambulance, blood-bank and power services each run a radius search and
publish a reaction with `correlationId = disasterId` → disaster-service
stores each reaction (idempotent, out-of-order safe) → the situation report
shows 4/4 services responded. notification-service receives every event,
keeps the last 200 in Redis and pushes them to every connected browser.

**Service responsibilities**

| Service | Port | Owns | Highlights |
|---|---|---|---|
| gateway | 8080 | — | single ingress; security pipeline; WS proxy; health aggregation |
| auth-service | 8081 | users, roles, refresh tokens | bcrypt ≥12, lockout, cookie refresh with rotation + reuse detection, admin user management |
| hospital-service | 8082 | hospitals | capacity %, alerts, radius search, ownership RBAC, SQL-aggregate summary |
| ambulance-service | 8083 | ambulances, emergencies | status state machine, transactional race-free dispatch, ETA estimate |
| blood-bank-service | 8084 | banks, batches, reservations, demand | FEFO reservations with row locks, transfers, shortages incl. depleted types, prototype forecast |
| power-service | 8085 | substations, transformers, readings, failure events | rule + statistical anomaly detection, one failure episode per outage |
| disaster-service | 8086 | disasters, reactions | event orchestrator, status machine, situation reports |
| notification-service | 8087 | Redis list | `#` consumer, per-pod live queue, WebSocket fan-out, ping/pong liveness |
| resilience-service | 8088 | — | six Kubernetes failure drills (Phase 11) |
| response-service | 8089 | disaster context, response plans, actions | Phase 15: playbook → plan → approval → command events → replies; undo; escalation (`docs/PHASE-15-RESPONSE-ENGINE.md`) |
| simulator-service | 8090 | — (one run in memory) | Phase 16: scripted scenarios + background activity, only through the gateway with its own service account (`docs/PHASE-16-SIMULATOR.md`) |

## 2. Directory tree

```
sentinelcloud/                         (≈430 files)
├── README.md · SECURITY.md · docker-compose.yml · .env.example
├── docs/                              SYSTEM-REFERENCE, ENGINEERING-REVIEW, EVENT-SCHEMA,
│                                      ARCHITECTURE (historical), ROADMAP, PHASE-1 … PHASE-11, images/
├── frontend/                          React 18 + Vite
│   ├── src/{App.jsx, main.jsx, styles.css}
│   ├── src/auth/                      AuthContext (cookie refresh), ProtectedRoute
│   ├── src/pages/                     CommandCenter, Hospital/Ambulance/BloodBank/Power/Emergency
│   │                                  dashboards, SystemHealth, Resilience, Users, Login, Register
│   ├── src/components/                CommandMap, MiniCharts
│   ├── src/lib/                       api.js, socket.js, events.js, settle.js, statusTier.js
│   ├── nginx/                         production server config + CSP headers
│   └── Dockerfile (nginx prod) · Dockerfile.dev (Compose)
├── services/
│   ├── gateway/                       src/{index,routeAccessRules,broker,metrics}.js, src/security/, tests/
│   ├── auth-service/                  migrations/, src/{routes,repositories,schemas,utils,security,db}, tests/
│   ├── hospital-service/              migrations/, src/{routes,services,repositories,consumers,events,…}, tests/
│   ├── ambulance-service/             same layout (+ db/transaction.js), tests/
│   ├── disaster-service/              same layout, tests/
│   ├── notification-service/          src/{index,redis,broker,metrics}.js, tests/
│   ├── resilience-service/            src/{index,runner,scenarios,k8s,rabbit,probes}.js, tests/ (fake cluster)
│   ├── blood-bank-service/            pom.xml, src/main/java/…/{controller,service,repository,entity,dto,event,
│   │                                  security,config,chaos,seed}, db/migration V1–V3, src/test/
│   └── power-service/                 same layout as blood-bank-service
├── shared/node-security/              canonical secrets/audit/jwt modules (synced into each Node service)
├── infrastructure/                    postgres-init/init-multiple-databases.sh, prometheus/prometheus.yml
├── k8s/
│   ├── base/apps/                     10 Deployments + Services + HPAs
│   ├── base/infrastructure/           postgres, redis, rabbitmq StatefulSets
│   ├── base/monitoring/               prometheus, alertmanager, grafana, kube-state-metrics + config/
│   ├── base/security/                 network-policies.yaml (default deny + 9 allow rules)
│   ├── base/config/ · base/demo/      common ConfigMap, init script copy, traffic generator
│   ├── overlays/local/                kustomization + secrets.env.example
│   └── cluster/                       kind-cluster.yaml, metrics-server patch
├── scripts/                           verify-system.sh, run-node-tests.sh, generate-secrets.sh,
│                                      k8s-build-images.sh, sync-shared-security.sh
└── tests/db/                          realPostgres.test.js + lib/miniPg.js (test-only wire client)
```

## 3. Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 18.3, react-router-dom 6, Vite 5.4; hand-rolled SVG charts/maps; nginx-unprivileged 1.27 in production |
| Node services | Node.js 22, Express 4.19, zod (validation), jsonwebtoken, bcryptjs, pg, amqplib, ioredis, ws, helmet, express-rate-limit, http-proxy-middleware |
| Java services | Java 21, Spring Boot 3.3, Spring Data JPA/Hibernate, Flyway, Spring Security, Spring AMQP, jjwt 0.12, Micrometer, springdoc |
| Data | PostgreSQL 16 (citext, pgcrypto), Redis 7 (AOF), RabbitMQ 3.13 (topic exchange, management + Prometheus plugins) |
| Containers | Docker multi-stage images, non-root numeric UIDs, Docker Compose v2 |
| Orchestration | Kubernetes 1.29+ (Kind / Minikube / k3s), Kustomize, HPA, NetworkPolicy, RBAC |
| Observability | Prometheus 2.54, Alertmanager 0.27, Grafana 11.2, kube-state-metrics 2.13, cAdvisor |
| Testing | node:test, supertest + pg-mem, JUnit 5 + Mockito, promtool, real-PostgreSQL suite, Playwright (UI checks) |

## 4. API list

All paths are behind the gateway at `/api/v1/<prefix>`. **Auth:** 🔓 public,
🔑 any signed-in user, otherwise the roles listed (SYSTEM_ADMIN can do
everything). Errors: `{"error":{"code","message","details?"}}`; 400 validation,
401 no/invalid token, 403 role, 404, 409 conflict/state, 429 rate limit, 503.

**Auth — `/auth`**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /register | 🔓 | create a CITIZEN (20/15 min/IP) |
| POST | /login | 🔓 | access token + httpOnly `sc_refresh` cookie; lockout after 10 failures |
| POST | /refresh | 🔓 cookie | rotate refresh token, new access token |
| POST | /logout | 🔓 cookie | end session (`allDevices: true` = everywhere) |
| GET | /me | 🔑 | own profile |
| GET | /users?page&limit | SYSTEM_ADMIN | list users |
| PATCH | /users/{id} | SYSTEM_ADMIN | change role / active (no self-lockout, never 0 admins) |
| GET | /docs | 🔓 | Swagger UI |

**Hospitals — `/hospitals`** (writes: HOSPITAL_ADMIN who manages the hospital)

| Method | Path | Purpose |
|---|---|---|
| GET | /?page&limit | list with capacity % and alerts |
| GET | /{id} | one hospital |
| GET | /near?lat&lng&radiusKm | radius search, nearest first |
| GET | /icu-available | hospitals with free ICU beds |
| GET | /alerts | all capacity alerts, CRITICAL first |
| GET | /stats/summary | totals + occupancy % (one SQL aggregate) |
| POST | / | register a hospital |
| PUT | /{id} | update profile/totals |
| PATCH | /{id}/beds · /{id}/icu · /{id}/ventilators | update availability |
| PATCH | /{id}/overload | mark overloaded / normal |

**Ambulances — `/ambulances`** (writes: EMERGENCY_OPERATOR)

| Method | Path | Purpose |
|---|---|---|
| GET | /?page&limit&status · /{id} · /stats/summary | fleet |
| GET | /nearest?lat&lng&radiusKm&limit&equipmentLevel | nearest AVAILABLE with distance + ETA |
| POST | / · PUT /{id} | register / update (duplicate plate → 409) |
| PATCH | /{id}/location · /{id}/status · /{id}/assign-hospital | updates (status follows the state machine) |
| POST | /{id}/dispatch | assign to an ACTIVE emergency (transactional; races → 409) |
| GET | /emergencies?page&limit&status · /emergencies/active · /emergencies/{id} | emergencies |
| POST | /emergencies | report + auto-dispatch nearest available |
| POST | /emergencies/{id}/complete · /cancel | close; cancelling frees the ambulance |

**Blood banks — `/blood-banks`** (writes: HOSPITAL_ADMIN)

| Method | Path | Purpose |
|---|---|---|
| GET | / · /{id} · /near?lat&lng&radiusKm | banks |
| POST | / · PUT /{id} | register / update |
| GET/POST | /{id}/inventory | batches / add batch |
| PUT | /inventory/{batchId} | correct a batch |
| POST | /{id}/transfer | FEFO transfer to another bank |
| POST | /{bloodBankId}/reservations | reserve from one batch (FEFO, row lock) |
| POST | /reservations/{id}/release | release (second release → 409) |
| GET | /reservations/active | active reservations |
| GET | /low-stock · /expiring-soon?withinDays · /alerts · /forecast?bloodType · /stats/summary | analytics |

**Power — `/power`** (writes: INFRASTRUCTURE_ADMIN)

| Method | Path | Purpose |
|---|---|---|
| GET | / · /{id} · /near · /{id}/transformers | substations |
| POST | / · PUT /{id} · POST /{id}/transformers | create/update |
| GET | /transformers/{id} · PUT /transformers/{id} | transformer |
| POST | /transformers/{id}/telemetry | reading → status, anomalies, failure episodes |
| POST | /transformers/{id}/status | manual status with reason |
| GET | /transformers/{id}/readings?limit · /anomalies · /failures | history |
| GET | /transformers/overloaded · /transformers/high-temperature · /alerts · /anomalies · /map · /stats/summary | analytics |

**Disasters — `/disasters`** (writes: EMERGENCY_OPERATOR)

| Method | Path | Purpose |
|---|---|---|
| POST | / | report → `disaster.detected` (`eventPublished` in the reply) |
| GET | /?page&limit&status&type · /active · /near?lat&lng&radiusKm(≤500) · /{id} | read |
| PUT | /{id} | severity/radius/description (409 once RESOLVED) → `disaster.updated` |
| POST | /{id}/status | `{status, note?}`; ACTIVE⇄CONTAINED→RESOLVED; RESOLVED is final |
| GET | /{id}/situation-report | fan-in of the four reactions |

**Response plans — `/response`** (Phase 15; decisions: EMERGENCY_OPERATOR)

| Method | Path | Purpose |
|---|---|---|
| GET | /plans?disasterId&status&limit | plans with their actions, newest first |
| GET | /plans/{id} | one plan |
| POST | /plans/{id}/approve · /reject · /undo | `{note?}`; conditional (a second decision → 409) |
| GET | /playbook | the playbook table and the mode (APPROVAL / AUTO) |

**Simulator — `/simulator`** (Phase 16; writes: SYSTEM_ADMIN) — GET
`/scenarios`, GET `/status` (current run with its steps, background mode,
write budget) 🔑; POST `/runs {scenarioId}`, `/runs/current/stop`,
`/ambient {enabled}`.

**Notifications** — GET `/notifications/events/recent?limit=1..200` 🔑;
Phase 14: GET `/notifications/dead-letters`, POST `/dead-letters/replay` SYSTEM_ADMIN;
WebSocket `/ws/live` 🔑. **Resilience** — GET `/resilience/scenarios`,
`/overview`, `/runs/current` 🔑; POST `/resilience/runs {scenarioId}`,
`/runs/current/abort` SYSTEM_ADMIN. **Gateway** — GET `/health`,
`/health/ready`, `/health/services` 🔓 (not under `/api/v1`).

## 5. Database schema

One PostgreSQL 16 instance; each service owns one database through its own
login role (not superuser, cannot create roles/databases, cannot connect to
another service's database — checked on a real server by `tests/db`).
Node services migrate with a 40-line runner (`schema_migrations`, advisory
lock across replicas); Spring services with Flyway (`flyway_schema_history`).

| Database | Tables (key columns) | Constraints / indexes |
|---|---|---|
| auth_db | `roles(id, name)`; `users(id uuid, email citext unique, password_hash, full_name, role_id→roles, is_active, created_at, updated_at)`; `refresh_tokens(id, user_id→users, token_hash unique, issued_at, expires_at, revoked_at, replaced_by_hash, user_agent, ip_address)` | case-insensitive unique email; expired tokens purged hourly |
| hospital_db | `hospitals(id, name, address, latitude, longitude, emergency_contact_*, total/available beds, total/available icu_beds, total/available ventilators, emergency_status, managed_by_user_id, timestamps)` | CHECK available ≤ total and ≥ 0 for all three; status ∈ NORMAL/ELEVATED/OVERLOADED; idx lat/lng, status, icu, manager |
| ambulance_db | `ambulances(id, vehicle_number unique, latitude, longitude, status, driver_*, equipment_level, assigned_hospital_id, assigned_emergency_id→emergencies)`; `emergencies(id, description, latitude, longitude, severity, status, assigned_ambulance_id→ambulances, assigned_hospital_id, created_by_user_id, created_at, resolved_at)` | status CHECKs; idx (status, created_at), created_at, lat/lng |
| blood_db | `blood_banks`; `blood_inventory_batches(id, blood_bank_id, blood_group, rh_factor, units_available, reserved_units, collection_date, expiry_date, version)`; `blood_reservations(id, batch_id, hospital_id, units_reserved, status, notes, reserved_by_user_id, reserved_at, released_at, fulfilled_at)`; `blood_demand_records` | optimistic `version` + pessimistic row locks; idx group/rh, expiry, bank |
| power_db | `substations`; `transformers(id, substation_id, code, rated_voltage_kv, rated_current_amps, status, last_* snapshot, last_reading_at, version)`; `transformer_readings(…, anomalous, anomaly_reasons, recorded_at)`; `transformer_failure_events(id, transformer_id, previous_status, new_status, reason, occurred_at, resolved_at)` | unique (substation, code); idx readings (transformer, recorded_at desc); partial idx open failure events |
| disaster_db | `disasters(id, type, severity, latitude, longitude, radius_km, description, status, status_note, created_by_user_id, occurred_at, …)`; `disaster_reactions(id, disaster_id→disasters, event_type, source_service, event_id, payload jsonb, received_at, event_occurred_at)` | unique (disaster, event_type, source); idx (status, occurred_at desc) |

`tests/db` additionally checks that every JPA `@Entity` field maps to a real
column (Hibernate runs with `ddl-auto: none`, so drift would only fail at
runtime).

## 6. Event schema

See [`EVENT-SCHEMA.md`](EVENT-SCHEMA.md): envelope, all 11 routing keys,
7 queues, payloads, delivery and ordering guarantees, WebSocket frames.

## 7. Docker architecture

- **16 Compose services** on one bridge network: postgres, redis, rabbitmq,
  prometheus, alertmanager, grafana, the 9 application services and the
  frontend (Vite dev server with the source mounted for hot reload).
- **Images:** multi-stage; Node services build with `npm ci` then run as
  uid 1000/1001; Spring services build with Maven and run on
  `eclipse-temurin:21-jre-alpine` as uid 1001 with
  `MaxRAMPercentage=55`, capped metaspace/code cache/thread stacks.
- **Healthchecks** on every container (Spring: `/health/liveness`, 90 s
  start period); `depends_on: condition: service_healthy` orders startup;
  Postgres is checked over TCP so it isn't "ready" during init.
- **Exposure:** only the gateway (8080), frontend (5173), RabbitMQ UI,
  Prometheus/Alertmanager/Grafana and the datastores are published, all on
  `${BIND_ADDRESS:-127.0.0.1}`; the 9 services have no host ports.
- **Hardening:** `no-new-privileges`, `cap_drop: [ALL]` (datastores get only
  the 5 capabilities their entrypoints need), secrets from `.env` with
  `${VAR:?}` guards. Postgres `max_connections=250` (pools: Node 5, Hikari 5).
- **Volumes:** postgres, redis (AOF), rabbitmq, prometheus, grafana.

## 8. Kubernetes architecture

- Namespace `sentinelcloud`; `kubectl apply --server-side -k k8s/overlays/local`.
- **StatefulSets + PVCs:** postgres (`max_connections=250`, TCP probes),
  rabbitmq, redis. **Deployments:** 9 application services + frontend
  (nginx, NodePort 30080), prometheus (30090), alertmanager (30093),
  grafana (30030), kube-state-metrics, traffic-generator (0 replicas).
- **Probes:** startup + readiness (dependencies) + liveness (process only)
  everywhere; Spring uses actuator health groups.
- **HPA:** gateway, hospital, ambulance 1→5; auth, disaster, notification,
  blood, power, frontend 1→3 (CPU 70–80 %).
- **Resources:** e.g. Node 100m/128Mi → 500m/256Mi; Spring 250m/512Mi →
  1500m/768Mi; Postgres → 1 CPU/512Mi.
- **Security:** default-deny NetworkPolicy + 9 allow rules (frontend from
  anywhere; gateway from frontend; services from gateway; drill targets from
  resilience; postgres only from DB services; redis only from notification;
  RabbitMQ from producers/consumers; monitoring); pods run non-root with
  read-only root FS, no service-account token unless needed; resilience-service
  has a namespaced Role (pods, events, endpointslices, deployments/statefulsets, HPAs), Prometheus only
  `nodes/metrics`.
- **Multi-replica correctness:** advisory-lock migrations, per-pod live
  queues, broker reconnect, graceful SIGTERM.

## 9. Monitoring architecture

- **Metrics:** every Node service exposes `/metrics` from a zero-dependency
  module; Spring exposes `/prometheus` via Micrometer with identical names
  and buckets: `http_server_requests_seconds`, `sentinel_events_published_total`,
  `sentinel_events_consumed_total{queue,event_type,outcome}`,
  `sentinel_event_handler_seconds`, `sentinel_event_processing_seconds`
  (end-to-end), `sentinel_dependency_up`, `sentinel_websocket_clients`,
  resilience drill metrics.
- **Prometheus:** Kubernetes service discovery (Compose: static targets),
  RabbitMQ plugin (aggregate + per-queue), cAdvisor via the kubelet,
  kube-state-metrics; **15 recording rules, 19 alert rules** with promtool
  unit tests.
- **Alertmanager:** grouping + 6 inhibition rules (e.g. ServiceDown
  suppresses latency/error alerts of the same service).
- **Grafana:** 4 provisioned dashboards — System Health (home), Service
  Detail, Event Bus, Kubernetes — 84 panel queries, all validated against a
  real Prometheus in this review.

## 10. Security architecture

Full detail in [`../SECURITY.md`](../SECURITY.md). In short: JWT HS256
(15 min) verified by the gateway **and** every service; refresh token in an
httpOnly SameSite=Strict cookie, rotated atomically with reuse detection;
bcrypt ≥ 12 with constant-time login and per-account lockout; sign-up is
CITIZEN-only, roles granted by SYSTEM_ADMIN; gateway path normalisation,
fail-closed role table, rate limits, CORS allow-list, audit log of every
write and denial; zod/Bean Validation on every input; parameterised SQL
only; least-privilege DB roles; Redis password; RabbitMQ per-environment
credentials; generated secrets with startup strength checks; NetworkPolicies;
strict CSP on the frontend. Phase 13 added: 409 instead of 500 for
constraint races, required `sub`/`role` claims in every verifier, bounded
metric labels, WebSocket backpressure limits.

## 11. Setup instructions

**Prerequisites:** Docker 24+ with Compose v2 (4 CPUs / 6 GiB for Kubernetes),
bash 4+ (macOS: `brew install bash`; Windows: WSL2/Git Bash), Node.js 22
(only for the scripts/tests), and for Kubernetes: kind 0.20+ and kubectl.

**Docker Compose**
```bash
./scripts/generate-secrets.sh compose        # .env with random secrets (chmod 600)
docker compose up -d --build                 # first build ≈ 5–10 min
open http://localhost:5173                   # log in: DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD from .env
```

**Kubernetes (Kind)**
```bash
kind create cluster --config k8s/cluster/kind-cluster.yaml
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system --type=json --patch-file k8s/cluster/metrics-server-kind-patch.json
./scripts/k8s-build-images.sh kind
./scripts/generate-secrets.sh k8s
kubectl apply --server-side -k k8s/overlays/local
kubectl -n sentinelcloud wait --for=condition=available deployment --all --timeout=600s
open http://localhost:30080                  # Grafana :30030, Prometheus :30090, Alertmanager :30093
```

**One-command verification:** `./scripts/verify-system.sh compose --yes`,
`… k8s --yes` or `… all --yes` (see §12).

## 12. Testing

| Suite | Command | Where it ran in the review |
|---|---|---|
| Node unit tests (34 files) | `./scripts/run-node-tests.sh` after `npm ci` per service | 25 dependency-free files here (231 tests, all pass); 9 need npm packages (express/zod/bcryptjs/jsonwebtoken) → run by `verify-system.sh` |
| Real-PostgreSQL integration (31 tests) | `SC_DB_TEST=1 SC_DB_TEST_ALLOW_RESET=1 PG…  node --test tests/db/realPostgres.test.js` | ✅ here, PostgreSQL 16.13 |
| Java unit tests | `mvn test` in both Spring services | `verify-system.sh` (Maven Central unreachable here); Java sources parse-checked, GeoUtils compiled + run |
| Alert-rule unit tests | `promtool test rules k8s/base/monitoring/config/prometheus/tests/alerts.test.yml` | ✅ here |
| 13 system checks | `./scripts/verify-system.sh {compose|k8s|all} --yes` | on a machine with Docker/Kind |

`verify-system.sh` also runs the DB suite against a throwaway
`postgres:16-alpine` container and every unit suite inside `node:22-alpine`
/ `maven:3.9-eclipse-temurin-21` containers.

## 13. Demonstration procedure

About 12 minutes, after `docker compose up` or the Kind deployment.

1. **Architecture slide** (§1), then open the app and log in as the admin.
2. **Command Center**: system status, KPIs from all four domains, map,
   alerts, live timeline. Resize the window to a phone width — the layout
   stacks (responsive since Phase 13).
3. **Users**: register a new account in a private window (it is a CITIZEN,
   read-only), then as admin promote it to EMERGENCY_OPERATOR.
4. **Emergency**: report a FLOOD near Pune (18.52, 73.85, 15 km). Watch the
   Live Event Feed: `disaster.detected`, then four reactions with the same
   correlation id; open the situation report → 4/4 services responded.
   Mark **Contained** (reactions run again), then **Resolved** (one
   `disaster.resolved`, no more buttons — it's final).
5. **Ambulances**: report an emergency via the API (`POST
   /api/v1/ambulances/emergencies`) — the nearest ambulance is dispatched;
   complete it and the ambulance is AVAILABLE again.
6. **Blood Banks / Power Grid**: low-stock and expiry alerts, demand
   forecast (prototype disclaimer); post a critical transformer reading and
   watch the status and alerts change.
7. **System Health / Grafana**: all services up; open the System Health
   dashboard; `kubectl scale deployment traffic-generator --replicas=1` for
   live traffic.
8. **Failure simulation**: Kubernetes → **Resilience Demo** → *Hospital
   service failure*: NORMAL → FAILED → DETECTED → SELF-HEALING → RESTORED,
   with the Kubernetes events as evidence. (Compose: `docker compose stop
   hospital-service` → System Health shows it down, other APIs keep working,
   Prometheus fires `SentinelServiceDown`; `docker compose start
   hospital-service`.)
9. **Proof**: run `./scripts/verify-system.sh compose --yes` (or show its
   saved output) — 13 checks with PASS/FAIL.

## 14. Known limitations

- **Simulation, not real infrastructure.** Data is seeded/synthetic; the
  blood demand forecast is an unvalidated statistical prototype.
- **Distances are estimates:** straight-line radius, road distance = ×1.3,
  fixed average speed; no routing engine. Maps are schematic SVG, not tiled.
- **Single Postgres instance and single-replica RabbitMQ/Redis** (no HA,
  no backups/PITR); database-per-service is logical isolation only.
- **Events are at-least-once, not exactly-once** (Phase 14 added the
  outbox, publisher confirms, retries and the dead-letter queue — see
  `docs/PHASE-14-RELIABLE-EVENTS.md`): consumers must tolerate duplicates,
  and do. Dead letters wait for an admin to replay them; nothing replays
  them automatically. The outbox relay polls every 2 s rather than using
  `LISTEN/NOTIFY`.
- **Dates in blood/power use the JVM's time zone** (UTC in the images).
- **Blood reservations** come from a single batch (no splitting); a
  concurrent reservation on the same batch may get `409 CONCURRENT_UPDATE`
  and must retry.
- **Power `/anomalies`** re-reads each transformer's history (N+1) — fine
  for the demo fleet, not for thousands of transformers.
- **In-cluster callers** that reach the gateway directly (not via nginx)
  could spoof `X-Forwarded-For`; NetworkPolicies limit who can.
- **Local TLS:** Compose is plain HTTP on localhost; cookies are `Secure`
  only in Kubernetes. No external IdP/MFA.
- **resilience-service** is not covered by the alert rules/dashboards
  beyond the drill timeline; drills need Kubernetes.
- **Frontend tests** are UI checks in a real browser (Playwright script in
  the review), not a committed component-test suite; no CI pipeline yet
  (ROADMAP phase 15).
