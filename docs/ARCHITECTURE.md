# SentinelCloud — Architecture & Roadmap

> **Historical design document (Phase 0).** Written before any code; kept
> for its rationale. Several sections (service inventory, database and API
> details, roadmap) describe the *plan*, not the final system. For the
> system as built and verified, read [`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md);
> for the event contract, [`EVENT-SCHEMA.md`](EVENT-SCHEMA.md).


**Cloud-Native Critical Infrastructure Intelligence & Emergency Response Platform**
*Individual Third-Year Cloud Computing Project*

This document was the architecture blueprint written before Phase 1.

---

## 1. System Architecture (High-Level View)

SentinelCloud is a **distributed, event-driven microservices system**. Five domain services own their own data and logic; they never reach into each other's databases. All cross-service coordination happens through:

1. **Synchronous REST calls** — for direct, user-triggered queries (e.g., dashboard asking Hospital Service for current bed counts).
2. **Asynchronous events over a message broker** — for emergency propagation (e.g., `DISASTER_DETECTED` fan-out).

```
                                   ┌─────────────────────────┐
                                   │        React SPA        │
                                   │  (Dashboard / Map / UI) │
                                   └────────────┬─────────────┘
                                                │ HTTPS / REST / WebSocket
                                   ┌────────────▼─────────────┐
                                   │       API Gateway        │
                                   │ (routing, JWT validation,│
                                   │  rate limiting, CORS)    │
                                   └──┬───┬───┬───┬───┬───────┘
                    ┌─────────────────┘   │   │   │   └───────────────────┐
                    │                 ┌────┘   │   └────┐                 │
              ┌─────▼─────┐   ┌───────▼───┐ ┌──▼──────┐ ┌▼────────────┐ ┌─▼─────────────┐
              │ Hospital  │   │ Ambulance │ │ Blood   │ │ Power       │ │ Disaster/Event │
              │ Service   │   │ Service   │ │ Bank    │ │ Infra       │ │ Intelligence   │
              │ (Node)    │   │ (Node)    │ │ Service │ │ Service     │ │ Service        │
              │           │   │           │ │ (Spring)│ │ (Spring)    │ │ (Node)         │
              └─────┬─────┘   └─────┬─────┘ └────┬────┘ └──────┬──────┘ └───────┬────────┘
                    │               │            │             │                │
              ┌─────▼─────┐   ┌─────▼─────┐ ┌────▼────┐  ┌─────▼─────┐   ┌──────▼──────┐
              │ hospital_db│   │ ambulance_db│ │ blood_db │  │ power_db  │   │ disaster_db │
              │ (Postgres) │   │ (Postgres)  │ │(Postgres)│  │(Postgres) │   │ (Postgres)  │
              └───────────┘   └───────────┘ └─────────┘  └───────────┘   └─────────────┘
                    │               │            │             │                │
                    └───────────────┴─────┬──────┴─────────────┴────────────────┘
                                           │
                                 ┌─────────▼─────────┐
                                 │  Message Broker    │
                                 │ (RabbitMQ topic     │
                                 │  exchange, or Kafka)│
                                 └─────────┬─────────┘
                                           │
                                 ┌─────────▼─────────┐
                                 │   Redis (cache +   │
                                 │  pub/sub for live   │
                                 │  dashboard updates) │
                                 └────────────────────┘

        Cross-cutting: Auth Service (JWT issuer) · Prometheus · Grafana · Centralized logging
```

**Key architectural decisions**

| Decision | Rationale |
|---|---|
| Database-per-service | Enforces true service independence; avoids shared-schema coupling common in student projects |
| API Gateway as single ingress | Centralizes JWT validation, avoids duplicating auth logic in every service |
| Event bus for emergency fan-out, REST for direct queries | Demonstrates both sync and async patterns — a common rubric requirement |
| RabbitMQ as primary broker (Kafka as documented alternative) | RabbitMQ is far lighter to run locally in Docker Compose on a student laptop; Kafka needs Zookeeper/KRaft + more RAM. We'll build on RabbitMQ and document how the same topology maps to Kafka topics, so you can swap it if your rubric requires Kafka specifically. |
| Redis for both caching and dashboard pub/sub | Avoids introducing a third messaging technology just for live UI updates |
| Two backend stacks (Node.js + Spring Boot) | Satisfies the "Node.js/Express where appropriate, Spring Boot where appropriate" requirement without arbitrarily forcing every service into one stack — see service-to-stack mapping below |

**Why these two services get Spring Boot:** Blood Bank and Power Infrastructure have the most relational, transactional integrity requirements (inventory counts, threshold breaches) and benefit from Spring's stronger typing, JPA/Hibernate migrations, and built-in Actuator health/metrics endpoints. Hospital, Ambulance, and Disaster services are more I/O- and event-driven (frequent small updates, geospatial calculations, event orchestration) which suits Node/Express's async model well. This is a defensible, explainable split for a viva/defense — not an arbitrary one.

---

## 2. Microservice Architecture

### 2.1 Service Inventory

| Service | Stack | Port (local) | Owns |
|---|---|---|---|
| API Gateway | Node/Express (http-proxy-middleware) | 8080 | Routing, JWT verification, rate limiting |
| Auth Service | Node/Express | 8081 | Users, roles, JWT issuance/refresh |
| Hospital Service | Node/Express | 8082 | Hospitals, beds, ICU capacity, patient load estimates |
| Ambulance Service | Node/Express | 8083 | Ambulances, dispatch, route calculation, status |
| Blood Bank Service | Spring Boot | 8084 | Blood units, inventory, shortage detection |
| Power Infrastructure Service | Spring Boot | 8085 | Substations, transformers, grid zones, outage impact |
| Disaster/Event Intelligence Service | Node/Express | 8086 | Disaster events, severity, affected-zone geometry, orchestration |
| Notification/Realtime Gateway | Node/Express + WebSocket | 8087 | Pushes live updates to dashboard via Redis pub/sub |
| React Frontend | React + Vite | 5173 (dev) | Dashboard, map, role-based views |

### 2.2 Service Responsibilities (Detail)

**Hospital Service**
- CRUD on hospitals, departments, bed types (general/ICU/pediatric)
- `POST /internal/hospitals/estimate-load` — triggered on disaster event, computes projected incoming patients using severity + population-in-zone heuristics
- Publishes `HOSPITAL_CAPACITY_UPDATED`

**Ambulance Service**
- Ambulance fleet CRUD, real-time status (`available`, `dispatched`, `en route`, `at hospital`, `maintenance`)
- Route calculation using Haversine distance + a simple graph/Dijkstra over a seeded road-node dataset (no paid Maps API required — this keeps the "no paid cloud services" rule intact)
- Publishes `AMBULANCE_STATUS_UPDATED`, `AMBULANCE_DISPATCHED`

**Blood Bank Service**
- Inventory CRUD per blood type per blood bank
- Threshold-based shortage detection engine
- Publishes `BLOOD_SHORTAGE_DETECTED`

**Power Infrastructure Service**
- Substation/transformer CRUD, geo-zone mapping
- Vulnerability scoring against a disaster's affected polygon
- Publishes `POWER_INFRASTRUCTURE_AT_RISK`

**Disaster/Event Intelligence Service**
- The orchestrator. Disaster CRUD (type, severity, affected zone as GeoJSON polygon, timestamps)
- On creation: publishes `DISASTER_DETECTED` to the broker; all four domain services subscribe
- Aggregates responses (via their published "reaction" events) into a `disaster_situation_report`
- Exposes `GET /disasters/:id/situation-report` for the dashboard

**Notification/Realtime Gateway**
- Subscribes to all domain events on the broker, republishes over Redis pub/sub, and pushes to connected dashboard clients via WebSocket — decouples the frontend from needing to know about RabbitMQ directly

### 2.3 Inter-Service Communication Matrix

| Caller → Callee | Protocol | Purpose |
|---|---|---|
| Gateway → all services | REST (proxied) | User-facing CRUD/query requests |
| Disaster Service → broker | Event publish | `DISASTER_DETECTED` |
| Hospital/Ambulance/BloodBank/Power → broker | Event subscribe/publish | React to disaster, publish own status events |
| Disaster Service → broker | Event subscribe | Aggregate reaction events into situation report |
| Notification Gateway → broker | Event subscribe | Fan events to WebSocket clients |
| Any service → Auth Service | REST (internal) | Validate/introspect tokens if not done at gateway |

**Failure isolation:** if Blood Bank Service is down, `DISASTER_DETECTED` events queue in RabbitMQ (durable queue) until it recovers — no data loss, and other services are unaffected. This demonstrates fault tolerance concretely and is worth calling out in your report.

---

## 3. Database Architecture

**Pattern: Database-per-service**, all on PostgreSQL for consistency (one exception noted below), each in its own Docker container/volume.

| Service | DB | Key Tables (preview only) |
|---|---|---|
| Auth Service | `auth_db` (Postgres) | `users`, `roles`, `refresh_tokens` |
| Hospital Service | `hospital_db` (Postgres) | `hospitals`, `bed_capacity`, `patient_load_estimates` |
| Ambulance Service | `ambulance_db` (Postgres) | `ambulances`, `dispatch_log`, `road_nodes` |
| Blood Bank Service | `blood_db` (Postgres) | `blood_banks`, `blood_inventory`, `shortage_alerts` |
| Power Service | `power_db` (Postgres) | `substations`, `transformers`, `grid_zones`, `impact_assessments` |
| Disaster Service | `disaster_db` (Postgres) | `disasters`, `affected_zones`, `situation_reports` |
| Cross-cutting cache | Redis | Session cache, live dashboard state, pub/sub channels |

**Migration tooling:** `node-pg-migrate` for Node services, Flyway for Spring Boot services — both are file-based, versioned, and runnable in Docker init, satisfying the "database migrations" requirement without hand-rolled SQL scripts.

**Geospatial data:** PostGIS extension enabled on `disaster_db` and `power_db` for affected-zone polygon storage and point-in-polygon vulnerability queries — this is a strong differentiator for a "critical infrastructure" project and still runs free locally via the `postgis/postgis` Docker image.

**Seed/demo data:** each service ships a `seed.sql` or migration-based seeder with realistic dummy hospitals, ambulances, blood banks, and substations (e.g., mapped to a real city's district layout) so a fresh `docker compose up` is immediately demoable.

---

## 4. Event Architecture

### 4.1 Broker Topology (RabbitMQ, topic exchange)

```
Exchange: sentinelcloud.events (type: topic, durable)

Routing keys:
  disaster.detected
  disaster.updated
  hospital.capacity.updated
  ambulance.status.updated
  ambulance.dispatched
  blood.shortage.detected
  power.infrastructure.at_risk

Queues (durable, one per consumer group):
  q.hospital.disaster-events      binds: disaster.detected, disaster.updated
  q.ambulance.disaster-events     binds: disaster.detected, disaster.updated
  q.bloodbank.disaster-events     binds: disaster.detected, disaster.updated
  q.power.disaster-events         binds: disaster.detected, disaster.updated
  q.disaster.reaction-aggregator  binds: hospital.capacity.updated, ambulance.status.updated,
                                          blood.shortage.detected, power.infrastructure.at_risk
  q.notifications.all-events      binds: # (wildcard — everything, for the realtime gateway)
```

### 4.2 Canonical Event Envelope

Every event on the bus follows the same JSON envelope (documented here structurally, no code yet):

- `eventId` (UUID)
- `eventType` (matches routing key)
- `occurredAt` (ISO timestamp)
- `sourceService`
- `correlationId` (ties an entire disaster's reaction chain together for tracing)
- `payload` (event-specific body)

### 4.3 Emergency Flow (Sequence)

```
Disaster Service            Broker              Hospital/Ambulance/
     │  publish                │                 BloodBank/Power Services
     │  disaster.detected      │
     ├─────────────────────────►
     │                         │  fan-out to 4 queues
     │                         ├──────────────────────────►  each computes its
     │                         │                              own reaction
     │                         │  hospital.capacity.updated
     │                         ◄──────────────────────────┤
     │                         │  ambulance.status.updated
     │                         ◄──────────────────────────┤
     │                         │  blood.shortage.detected
     │                         ◄──────────────────────────┤
     │                         │  power.infrastructure.at_risk
     │                         ◄──────────────────────────┤
     │  q.disaster.reaction-   │
     │  aggregator consumes ───┤
     │  all 4, builds          │
     │  situation_report       │
     │                         │
     │                         │  (in parallel) Notification Gateway consumes
     │                         │  everything, pushes to WebSocket → React
     │                         │  dashboard updates live, no polling
```

**Why this matters for grading:** this is a genuine publish-subscribe fan-out/fan-in pattern with a correlation ID for traceability — not just "services calling each other," which is what most student projects mistakenly submit as "event-driven."

**Kafka alternative (documented, not built by default):** the same routing keys become topics (`disaster.detected`, etc.), consumer groups per service replace queue bindings, and the aggregator becomes a stateful consumer. We can switch to this in a later phase if your course specifically requires Kafka.

---

## 5. API Architecture

- **Style:** REST, resource-oriented, versioned under `/api/v1/...`
- **Gateway routes:**
  - `/api/v1/auth/*` → Auth Service
  - `/api/v1/hospitals/*` → Hospital Service
  - `/api/v1/ambulances/*` → Ambulance Service
  - `/api/v1/blood-banks/*` → Blood Bank Service
  - `/api/v1/power/*` → Power Service
  - `/api/v1/disasters/*` → Disaster Service
  - `/ws/live` → Notification Gateway (WebSocket upgrade)
- **Documentation:** OpenAPI 3.0 spec per service, aggregated at the gateway and served via Swagger UI at `/api/docs` — satisfies "API documentation" as a browsable, testable artifact rather than a static markdown table.
- **Error format:** every service returns a consistent envelope — `{ error: { code, message, details, correlationId } }` — with standard HTTP status codes (400/401/403/404/409/422/500), so the frontend has one error-handling code path.
- **Validation:** request-body schema validation at the edge of every service (`zod` for Node services, `jakarta.validation`/Bean Validation for Spring services) — rejects malformed input before it touches business logic.
- **Pagination:** cursor or offset-based (`?page=&limit=`) on all list endpoints.
- **Health checks:** every service exposes `GET /health` (liveness) and `GET /health/ready` (readiness, checks DB + broker connectivity) — required for both Docker Compose healthchecks and later Kubernetes probes.

---

## 6. Frontend Architecture

- **Stack:** React 18 + Vite, React Router, TanStack Query (server-state/caching), Zustand or Context for lightweight client state, Recharts for charts, Leaflet (OpenStreetMap tiles — free, no API key) for the infrastructure map.
- **Structure (conceptual, not created yet):**
  - `src/pages/` — Dashboard, HospitalManagement, AmbulanceTracking, BloodBankInventory, PowerGrid, DisasterConsole, Login
  - `src/components/` — shared UI (StatCard, StatusBadge, AlertBanner, MapView, ChartPanel)
  - `src/features/<domain>/` — domain-specific API hooks + types, one folder per microservice
  - `src/lib/api.ts` — single Axios instance pointed at the gateway, with JWT interceptor
  - `src/lib/socket.ts` — WebSocket client for live updates
  - `src/auth/` — role-based route guards (`<RequireRole role="hospital_admin">`)
- **Real-time behavior:** dashboard subscribes to `/ws/live`; incoming events update TanStack Query cache directly (no polling), so bed counts, ambulance status, and alerts update live during a simulated disaster.
- **Role-based UI:** navigation and available actions are filtered client-side by JWT role claims, and re-enforced server-side (never trust client-side checks alone) — this pairing is worth stating explicitly in your report as a security best practice.

---

## 7. Docker Architecture (Local-First, Free)

- Each service gets its own multi-stage `Dockerfile` (build stage → slim runtime stage).
- One root `docker-compose.yml` orchestrates:
  - 6 app services + gateway + notification gateway
  - 5 Postgres containers (or one Postgres instance with 5 databases, to save laptop RAM — documented as a configurable option)
  - 1 Redis container
  - 1 RabbitMQ container (with management UI on `15672`)
  - 1 Prometheus + 1 Grafana container
- **Environment variables:** `.env.example` per service, real `.env` gitignored, injected via `env_file:` in Compose.
- **Networking:** single Compose bridge network `sentinelcloud-net`; services reach each other by container name (e.g., `http://hospital-service:8082`).
- **Volumes:** named volumes per database for persistence across restarts; seed data loads once on first container init.
- **Healthchecks:** Compose `healthcheck:` blocks call each service's `/health` endpoint; dependent services use `depends_on: condition: service_healthy` so the stack starts in the correct order without manual sleeps.
- **Everything free:** no AWS/GCP/Azure resource is required to run `docker compose up` end-to-end.

---

## 8. Kubernetes Architecture (Deployment Target, Later Phase)

> **Built in Phase 9.** See [`PHASE-9-KUBERNETES.md`](PHASE-9-KUBERNETES.md)
> for the as-built manifests, and its §16 for the few deliberate
> deviations from this plan (NodePort + nginx instead of an Ingress;
> HPA-owned replica counts instead of a fixed 2).

Provided after Docker Compose is fully working, as a parallel deployment path, not a replacement for local dev.

- **Namespace:** `sentinelcloud`
- **Per service:** `Deployment` (2 replicas for statelessness demo) + `Service` (ClusterIP) + `ConfigMap` (non-secret env) + `Secret` (DB credentials, JWT signing key)
- **Ingress:** single `Ingress` resource routing `/api/*` to the gateway Service, terminating TLS (self-signed for local `minikube`/`kind`, cert-manager-ready for real cloud)
- **Databases:** for coursework scope, Postgres/Redis/RabbitMQ run as `StatefulSet`s with `PersistentVolumeClaim`s inside the cluster (documented note: in a real production deployment these would be managed cloud services — RDS/CloudSQL/managed RabbitMQ — but that would violate the "no paid cloud account required" rule, so we self-host in-cluster and document the swap-out point)
- **Scaling demo:** `HorizontalPodAutoscaler` on the Ambulance Service (CPU-based) — a natural service to scale during a simulated mass-casualty event, good for a live demo
- **Local K8s target:** `kind` or `minikube`, so this also requires zero paid cloud spend
- **Manifests organized as:** `k8s/base/` (Kustomize base) + `k8s/overlays/local/` and `k8s/overlays/cloud/` — lets you show the same manifests deploying locally and (optionally, later) to a real cloud free-tier cluster without duplication

---

## 9. Monitoring Architecture

> **Built in Phase 10.** See [`PHASE-10-MONITORING.md`](PHASE-10-MONITORING.md).
> As-built differences from this plan: Node services use a small,
> dependency-free `metrics.js` instead of `prom-client` (same metric
> names); Kubernetes scraping uses pod annotations + `kubernetes_sd_configs`
> rather than ServiceMonitors (no Prometheus Operator); structured JSON
> logging and Loki are not yet implemented.

- **Metrics:** every service exposes `/metrics` in Prometheus format —
  - Node services: `prom-client`
  - Spring services: Spring Boot Actuator + Micrometer's Prometheus registry
- **Prometheus:** scrapes all `/metrics` endpoints via a static `scrape_configs` list (Compose) or `ServiceMonitor` (K8s), polling every 15s.
- **Grafana:** pre-provisioned dashboards (JSON, checked into repo) for: (1) per-service request rate/latency/error rate (RED metrics), (2) RabbitMQ queue depth, (3) business metrics — active disasters, total ambulances dispatched, blood units below threshold.
- **Logging:** structured JSON logs (`pino` for Node, `Logback` JSON encoder for Spring) with `correlationId` on every line, so a single disaster's ripple effect across five services can be traced in log aggregation (Compose: stdout, collected by `docker logs`; documented upgrade path to Loki if desired).
- **Alert-worthy conditions** (documented, optionally wired to Grafana Alerting): a domain service's readiness probe failing, RabbitMQ queue depth exceeding a threshold (consumer falling behind), blood/bed shortage events not being acknowledged within N seconds.

### 9a. Resilience (failure simulation)

> **Added in Phase 11.** See [`PHASE-11-RESILIENCE.md`](PHASE-11-RESILIENCE.md).

- **resilience-service** (Node, no dependencies) runs one controlled drill at a time. It talks to the Kubernetes API with its own ServiceAccount (namespace-scoped Role: list/get/delete pods, patch HPAs, read events/endpoints) and to the RabbitMQ management API (isolated drill exchange/queue only).
- **Fault injection is inside the services themselves:** `/internal/chaos` (hang, crash, clear), enabled only by `CHAOS_ENABLED=true` (Kubernetes ConfigMaps) plus a shared `X-Chaos-Token`; the gateway refuses every `/internal` path from outside.
- A drill advances Normal → Failure → Detection → Recovery → Restored only when the cluster *observably* reaches each state (probe failure events, EndpointSlice changes, restart counts, new pod UIDs, HPA decisions), and always cleans up.
- Exposed at `/api/v1/resilience` through the gateway (read: any signed-in user; start/abort: `SYSTEM_ADMIN`) and shown on the frontend's **Resilience Demo** page; stage metrics feed a Grafana timeline.

---

## 10. Security & Access Architecture

> **Built in Phase 12.** See [`SECURITY.md`](../SECURITY.md) for the as-built
> design. Differences from this plan: tokens are signed with **HS256** (a
> shared secret, algorithm pinned on every verifier) rather than RS256 —
> listed there as an accepted risk with RS256 as the upgrade path; the
> refresh token is an httpOnly cookie; sign-up is CITIZEN-only and a
> SYSTEM_ADMIN grants roles; plus per-service database users,
> NetworkPolicies, rate limits, a strict CSP and a structured audit log.

- **AuthN:** Auth Service issues short-lived JWT access tokens + longer-lived refresh tokens; JWT signed with RS256 (asymmetric — gateway can verify with a public key without calling Auth Service on every request).
- **AuthZ:** role claim embedded in JWT; gateway performs coarse-grained route protection, each service performs fine-grained resource-level checks (e.g., a Hospital Administrator can only edit *their own* hospital's beds).

| Role | Representative Permissions |
|---|---|
| Citizen | View public dashboard, disaster alerts, nearby hospital/ambulance status (read-only) |
| Emergency Operator | Dispatch ambulances, acknowledge/escalate disaster events, view all service data |
| Hospital Administrator | Manage their hospital's bed/ICU capacity and patient load data |
| Infrastructure Administrator | Manage substations/transformers, acknowledge power risk alerts |
| System Administrator | User/role management, service health overview, full read/write across all domains |

- **Transport security:** HTTPS at the gateway/ingress in deployed environments; documented as a config toggle for local dev (HTTP is fine locally).
- **Secrets:** never committed — `.env` files gitignored, K8s `Secret` objects for the cluster path.

---

## 11. Complete Development Roadmap

Each phase below follows your required loop: architecture → files → working code → wiring explanation → run commands → tests → known issues fixed → then stop for your go-ahead.

| Phase | Scope | Outcome |
|---|---|---|
| **0 (done)** | Architecture (this document) | Shared understanding before any code |
| **1** | Repo scaffolding + Auth Service + API Gateway + Docker Compose skeleton (just these two services + Postgres + Redis running) | You can register/login and get a real JWT through the gateway |
| **2** | Disaster/Event Intelligence Service + RabbitMQ integration + event envelope/publish logic | You can create a disaster and see it published as a real event (inspectable via RabbitMQ management UI) |
| **3** | Hospital Service, subscribing to `disaster.detected`, publishing `hospital.capacity.updated` | First full event round-trip: create disaster → hospital reacts automatically |
| **4** | Ambulance Service (with route/dispatch logic) | Second reactive service; dispatch simulation works |
| **5** | Blood Bank Service (Spring Boot) + Power Infrastructure Service (Spring Boot) | All five domain services reactive; full fan-out/fan-in working end-to-end |
| **6** | Notification/Realtime Gateway (WebSocket) + Redis pub/sub wiring | Live-updating backend, testable with a simple WS client before frontend exists |
| **7** | React frontend: auth flow, role-based routing, base dashboard shell | Loggable-into UI, role-aware navigation |
| **8** | Frontend: Hospital/Ambulance/BloodBank/Power domain pages + charts | Full CRUD UI per domain |
| **9** | Frontend: live map (Leaflet) + real-time dashboard wiring to WebSocket | The "wow factor" demo screen |
| **10** | Monitoring: Prometheus + Grafana + dashboards, health checks hardening | Observable system, screenshot-ready for report |
| **11** | Testing: unit tests (per service) + integration tests (event flow, API contracts) | Test coverage report, CI-runnable |
| **12** | Kubernetes manifests + Kustomize overlays + local `kind`/`minikube` deployment | Same system running on K8s, demoable as the "cloud-native" deliverable |
| **13** | Hardening pass: error handling audit, validation audit, seed/demo data polish, README + architecture diagrams finalized | Submission-ready |

**Recommended minimum viable demo path** if time is tight: Phases 1–7 + 9 + 10 gives you a working, visually convincing, live-updating system with monitoring — Phases 11–13 add depth/rigor for grading but aren't required for the "wow" demo.

---

### Where this plan ended up

The project was delivered in 13 phases (see [`ROADMAP.md`](ROADMAP.md)):
the order changed (Kubernetes before testing, the Command Center as its
own phase, a dedicated security phase and a final engineering review),
and several details above changed during implementation. The current,
verified description of the system is
[`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md).
