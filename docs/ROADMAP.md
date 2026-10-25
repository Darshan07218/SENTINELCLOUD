# SentinelCloud — Development Roadmap

This is the authoritative phase list for the project. The current
system is described in [`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md);
[`ARCHITECTURE.md`](ARCHITECTURE.md) keeps the original design rationale.
Status is updated at the top of each phase's entry as work completes.

| Phase | Scope | Status |
|---|---|---|
| 0 | Architecture design (no code) | ✅ Done |
| 1 | Repo scaffolding, all services + frontend + infra wired for networking, DB/broker connectivity, and health checks. No business logic. | ✅ Done |
| **2** | **Authentication & authorization: registration, login, JWT access/refresh tokens, logout, RBAC middleware at the gateway, frontend login/register/protected routes.** | ✅ Done |
| **3** | **Hospital Intelligence Service: registration, capacity management, geo queries, capacity alerts, per-hospital ownership RBAC, frontend dashboard, seed data, tests.** | ✅ Done |
| **4** | **Ambulance & Emergency Response Service: fleet management, status state machine, the full dispatch workflow (find/rank/recommend/assign/publish), realistic routing/ETA, frontend fleet map, seed data, tests.** | ✅ Done |
| **5** | **Blood Bank Intelligence Service (Spring Boot): batch-level inventory, FEFO reservations, transfers, low-stock/expiry detection, shortage alerts, prototype demand forecasting, dashboard charts, tests.** | ✅ Done |
| **6** | **Power Infrastructure Service (Spring Boot): substation/transformer CRUD, telemetry ingestion, rule-based + statistical anomaly detection, automatic status transitions with failure history, aggregated alerts, overloaded/high-temperature detection, map data, dashboard, tests.** | ✅ Done |
| **7** | **Disaster/Event Intelligence Service: disaster CRUD, `DISASTER_DETECTED`/`DISASTER_UPDATED` publishing, event-driven reactions in Hospital/Ambulance/Blood Bank/Power services (no synchronous calls), fan-in situation-report aggregation, full WebSocket event fan-out, live emergency dashboard, tests (unit tests per service; the whole publish → fan-out → fan-in flow is exercised end to end by check 8 of `scripts/verify-system.sh`).** | ✅ Done |
| **8** | **SentinelCloud Command Center: unified emergency-operations-center dashboard — global system status, active disasters, interactive multi-layer map, per-domain summaries (hospitals/ambulances/blood banks/power), unified alerts feed, live event timeline, service health, infrastructure statistics; 5 real-data charts; 4-tier color coding (green/yellow/orange/red) applied consistently across every domain's own status vocabulary; filtering by location/severity/infrastructure type/time; auto-updates from the Phase 7 live feed.** | ✅ Done |
| **9** | **Kubernetes deployment: production images for all 9 services, manifests (Deployments, StatefulSets + PVCs for Postgres/Redis/RabbitMQ, ClusterIP/NodePort Services, ConfigMaps, generated Secret, HPAs, startup/readiness/liveness probes, requests/limits), Kind + Minikube workflows, scaling demo; fixes for multi-replica correctness (migration lock, per-pod live queue, broker reconnect, graceful SIGTERM). See docs/PHASE-9-KUBERNETES.md.** | ✅ Done |
| **10** | **Monitoring & observability: Prometheus metrics in all 8 services (zero-dependency Node module + Micrometer, identical names), event-processing latency, dependency gauges; Prometheus (K8s service discovery, cAdvisor, kube-state-metrics, RabbitMQ), 15 recording + 19 alert rules with promtool unit tests, Alertmanager with inhibition, 4 provisioned Grafana dashboards (System Health home), demo traffic generator and presentation runbook. See docs/PHASE-10-MONITORING.md.** | ✅ Done |
| **11** | **Failure simulation — Resilience Demo: zero-dependency resilience-service (Kubernetes API client with least-privilege RBAC, RabbitMQ management client) running six controlled software-fault drills — hospital hang, ambulance crash, blood-bank Spring `LivenessState.BROKEN`, power pod loss, emergency traffic surge (HPA), message-broker outage with queue buildup — each advancing Normal → Failure → Detection → Recovery → Restored only on observed cluster state, with Kubernetes events as evidence and guaranteed cleanup; token-gated fault endpoints in the four target services; admin-only "Resilience Demo" page; Grafana drill timeline; verified on a real k3s cluster. See docs/PHASE-11-RESILIENCE.md.** | ✅ Done |
| **12** | **Security hardening: whole-project review; CITIZEN-only sign-up + admin role management (Users page); refresh token in an httpOnly cookie with atomic rotation and reuse detection; HS256 pinned everywhere; constant-time login + per-account lockout; gateway path normalisation (case/encoding bypasses), fail-closed role table, per-IP/per-user/WebSocket rate limits, CORS allow-list, authenticated + origin-checked live feed; strict CSP and security headers; secrets only from the environment with startup checks and a generator; per-service Postgres users; Redis password; NetworkPolicies; data-store securityContexts; Prometheus without nodes/proxy; structured audit log; event and parameter validation; Node 22. See SECURITY.md.** | ✅ Done |
| **13** | **Engineering review: whole-system audit (bugs, APIs, naming, validation, error handling, security, Docker, Kubernetes, database, frontend, latency, tests, docs); transactional race-free dispatch, power failure-episode fix, blood release double-credit fix, depleted-type shortages, broker crash hardening, constraint errors → 409, disaster status machine + note + `disaster.resolved`, out-of-order reaction guard, readiness-based health aggregation with cache, WebSocket liveness, Redis fail-fast, Postgres sizing, JVM memory caps, Compose/K8s parity; responsive UI, partial-failure dashboards, a11y; real-PostgreSQL integration suite, test runner, one-command 13-check verifier; system reference + review docs. See docs/ENGINEERING-REVIEW.md.** | ✅ Done |
| 14 | Reliable events: transactional outbox, publisher confirms, retries + dead-letter queue, outbox/dead-letter monitoring. See [docs/PHASE-14-RELIABLE-EVENTS.md](PHASE-14-RELIABLE-EVENTS.md). | ✅ Done |
| 15 | Automated response engine: playbooks per disaster type/severity, auto and approval modes, recorded and reversible actions, escalation. See [docs/PHASE-15-RESPONSE-ENGINE.md](PHASE-15-RESPONSE-ENGINE.md). | ✅ Done |
| 16 | Scenario simulator: scripted disasters played out through the API with their own service account, and background activity (ambulance trips, readings). See [docs/PHASE-16-SIMULATOR.md](PHASE-16-SIMULATOR.md). | ✅ Done |
| 17 | CI pipeline running `scripts/run-node-tests.sh`, `mvn test`, promtool and `verify-system.sh compose` on every push; KEDA autoscaling on queue length. See [docs/PHASE-17-CI-AND-KEDA.md](PHASE-17-CI-AND-KEDA.md). | ✅ Done |
| 18 | Real tiled maps (Leaflet) everywhere, incl. a hospital risk map; bed-occupancy forecast (capacity history via trigger, damped Holt smoothing, ETA to the 90 % line) and transformer-risk forecast (trend projection, 0–100 score with reasons). See [docs/PHASE-18-MAPS-AND-FORECASTS.md](PHASE-18-MAPS-AND-FORECASTS.md). | ✅ Done |
| 19 | Automatic disaster detection: intake-service polls USGS earthquakes and Open-Meteo rain/wind for the city, stores each event once, auto-confirms CRITICAL, keeps the rest for an operator (Auto-Detection page), creates disasters through the gateway with its own EMERGENCY_OPERATOR account. See [docs/PHASE-19-AUTO-DETECTION.md](PHASE-19-AUTO-DETECTION.md). | ✅ Done |
| 20 | Smarter response: impact estimate (population density × casualty rates → beds, ICU, ambulances, blood), bed reservations held and released through commands, forecast-aware hospital and transformer choices; fixed a race that could leave a plan EXECUTING. See [docs/PHASE-20-SMARTER-RESPONSE.md](PHASE-20-SMARTER-RESPONSE.md). | ✅ **Done — this phase** |

## Rule for every phase

1. Explain the architecture for that phase
2. Create the required files
3. Write complete, working code (no placeholders/TODOs)
4. Explain how the new files connect to what already exists
5. Provide exact commands to run
6. Test the implementation
7. Identify likely errors
8. Fix those errors
9. Stop and wait for the go-ahead before starting the next phase

Phases 8 and 9 of the original plan (notification gateway, live frontend
wiring) were folded into Phase 7; the numbers above are the delivered phases.
