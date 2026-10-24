# Phase 13 — Engineering review

A whole-system audit of SentinelCloud after Phase 12, followed by fixes and
verification. Ground rules: don't rewrite working components, don't replace
functional code with mock data, fix every confirmed defect, and be explicit
about what was actually executed.

**Result:** 40+ defects fixed across 9 services, the frontend, Compose and
Kubernetes; about 110 files changed and 15 added; a 31-test real-PostgreSQL suite,
a Node test runner and a one-command 13-check verifier added. Current system
description: [`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md).

---

## 1. How the review was done

Five parallel audits read every file in their area: API contracts
(all 46 frontend API calls traced through the gateway to a handler), events,
backend + database, infrastructure (Docker/K8s/monitoring), and
frontend + tests + docs. Each finding was then checked against the code
before fixing; findings that turned out to be by design are listed in §4.

## 2. What was found and fixed

Severity: **H** = wrong results or corrupted state in normal use,
**M** = failure under concurrency, load or partial outage, **L** = quality.

### Correctness and data integrity

| Sev | Area | Defect | Fix |
|---|---|---|---|
| H | Ambulance | Two concurrent dispatches could send **one ambulance to two emergencies** (read-then-write with no transaction). Reproduced on real Postgres with the original code: **20 of 20** races double-assigned. | Dispatch, complete and cancel run in one transaction; the ambulance claim (`… WHERE status='AVAILABLE'`) and the emergency claim (`… WHERE status='ACTIVE'`) are conditional UPDATEs; losing a race → 409 and nothing is written. |
| H | Ambulance | `POST /emergencies` could answer **409 although the emergency was created** (auto-dispatch lost a race). | Auto-dispatch tries candidates nearest-first and skips ones taken concurrently; the emergency is either assigned or left ACTIVE — always 201. |
| H | Ambulance | Completing an old emergency **freed an ambulance already re-dispatched** to another call. | Release only `WHERE assigned_emergency_id = <this emergency>`. |
| H | Ambulance | Cancelling an ASSIGNED emergency **stranded its ambulance as DISPATCHED** forever. | Cancel releases it (AVAILABLE if it hadn't reached a patient; otherwise it keeps its status). |
| M | Ambulance | Radius filter used the **road estimate (×1.3)** instead of straight-line km, shrinking every search radius by 23 %. | Straight-line Haversine for "within radius"; road estimate only for ranking/ETA. |
| M | Ambulance | `availableAmbulanceCount` in disaster reactions was **capped at 20**. | Count all; list the nearest 20. |
| H | Power | CRITICAL → FAILED opened a **second open failure event**; the next recovery then threw `IncorrectResultSizeDataAccessException` and **every later telemetry write for that transformer failed**. | One failure episode per outage (open only when entering the bad range, resolve all open events on leaving it). Lookup returns a list, so existing duplicate rows heal too. |
| H | Power | A **backdated reading overwrote the live snapshot** and status. | Older readings are stored as history only. |
| M | Power | `/transformers/overloaded` and `/high-temperature` loaded the whole fleet. | Use the existing indexed repository queries. |
| H | Blood | Two concurrent releases of one reservation **credited the units twice**. | Reservation row is locked (`SELECT … FOR UPDATE`) before the status check. |
| H | Blood | **Fully depleted blood types never raised a low-stock alert** (no batch rows → nothing to group). | Low-stock evaluates every bank × all 8 types; missing = 0 units = CRITICAL. |
| M | Blood | Disaster reaction reported **network-wide** shortages, not those at nearby banks. | Filter to the banks inside the disaster radius. |
| M | Blood | Expiry alert used `Period.getDays()` → "expires in 3 days" for 1 month 3 days. | `ChronoUnit.DAYS.between`. |
| H | Disaster | **Any status change was allowed** (RESOLVED → CONTAINED …), and buttons used a stale status. | State machine ACTIVE⇄CONTAINED→RESOLVED (final), conditional UPDATE against the validated state; details of a RESOLVED disaster are read-only. |
| M | Disaster | The status `note` was **accepted and silently dropped**. | Stored (`status_note`, migration 0003) and shown in the situation report. |
| M | Disaster | Resolving re-published `disaster.updated` → **all four services re-ran their searches** for a finished disaster. | New `disaster.resolved` key, consumed only by the live feed. |
| M | Disaster | A **late, older reaction overwrote a newer one**. | Store the publisher's `occurredAt`; upsert only replaces with an event at least as new. |
| M | All Node | Constraint races (duplicate email/plate, capacity CHECK) returned **500**. | `23505/23514/23503 → 409` in every service's error handler; specific codes for register/plate. |
| M | Auth | `refresh_tokens` **grew forever**. | Hourly purge of tokens expired > 24 h. |
| L | Geo (5 copies) | Bounding box **broke across the ±180° meridian**; Haversine could return NaN for antipodal points. | Full-longitude box when crossing; clamp. Tests added. |

### Reliability (broker, health, real-time)

| Sev | Defect | Fix |
|---|---|---|
| H | A JSON `null` body **crashed every Node consumer** (`envelope.eventType` in the catch) and could double-ack. | Reject non-object bodies; single settle path that can't throw. |
| H | No `error` listener on the AMQP channel: a channel error **crashed the process**; a dead channel still reported "connected". | Channel error/close listeners route into the existing reconnect path; half-open connections closed on failed setup. |
| M | Metric label `event_type` came from the untrusted body (unbounded series). | Label by delivered routing key; resilience-service route label bounded too. |
| M | Gateway `/health/services` probed **liveness** (always "up") and fanned out 8 requests per call per tab. | Probes readiness (`/health/ready`, Spring `/health/readiness`), 5 s shared cache. |
| M | notification-service: no ping/pong (dead sockets never removed), no backpressure limit; Redis offline queue made readiness **hang** instead of failing; LPUSH/LTRIM not atomic; no 404. | 30 s ping sweep, 1 MB buffered limit, `commandTimeout` + fail fast, MULTI, 404 handler. |
| L | Java events had microsecond timestamps; Node publishes lacked `contentType`. | ms precision everywhere; `contentType`/`messageId` set. |

### Infrastructure

| Sev | Defect | Fix |
|---|---|---|
| H | Compose Postgres healthcheck used the Unix socket → "healthy" **during init**, services connected to a server about to restart. | TCP check (`-h 127.0.0.1`) + `start_period`. |
| M | Pools could open ~220 connections vs `max_connections=100`. | Pools 5 (Node, Hikari) and `max_connections=250` (Compose + K8s). |
| M | Spring pods: 65 % heap + uncapped metaspace/code cache could hit the 768 Mi limit (OOM-kill, exit 137). | 55 % heap, MaxMetaspaceSize, ReservedCodeCacheSize, Xss. |
| M | Spring HEALTHCHECK used `/health` (includes RabbitMQ) with a 30 s start period. | `/health/liveness`, 90 s. Jar name no longer hardcoded. |
| M | `baseline-on-migrate: true` could skip V1 on a wrongly-pointed database. | false. |
| M | `generate-secrets.sh` failed cryptically on macOS bash 3.2. | bash ≥ 4 guard with instructions. |
| L | Compose used `postgis/postgis`, K8s `postgres:16-alpine` (nothing uses PostGIS). | Both use `postgres:16-alpine`. |
| L | `POSTGRES_SERVICE_DATABASES` sat in the ConfigMap loaded by every pod. | Postgres-only env value. |
| L | Compose: Redis had no volume, resilience no `depends_on`, frontend "hot reload" had no source mount, unused `VITE_WS_URL`. | Fixed. Image-tag/rollout reminder in `k8s-build-images.sh`. |

### Frontend

| Sev | Defect | Fix |
|---|---|---|
| H | "Mark Contained/Resolved" shown to **every role**, based on a stale status. | Shown only to EMERGENCY_OPERATOR/SYSTEM_ADMIN, from the freshly polled report; includes Re-activate; none once RESOLVED. |
| H | **Not responsive**: fixed two-column grids, 360/400 px cards, a table clipped by `overflow:hidden`, header that didn't wrap. | `styles.css` with breakpoints (stacking at ≤1024 px, single-column forms ≤640 px), wrapping header, scrollable tables. Checked at 375/768/1366 px. |
| M | One failing endpoint **blanked whole dashboards** (`Promise.all`). | `settle()` (allSettled) — panels keep what loaded and say what didn't. |
| M | Out-of-order responses (forecast type, transformer readings, user pages). | latest-request guard. |
| M | REST bootstrap **replaced** live events (lost/duplicated). Null frames crashed pages. | Merge + de-dupe by eventId; envelope validation. |
| M | Hidden tabs kept polling (16 requests/reload). | Pause when hidden, refresh on return; burst-debounced reloads. |
| L | Situation panel kept the previous disaster's report; wrong "retrying" text after logout; missing labels/`aria-current`/skip link/keyboard-reachable list items; the lowest-contrast greys on the Emergency page and header; favicon 404; event labels missing for 5 keys. | Fixed; shared `lib/events.js`. |

### Documentation

README (stale status, Swagger links that 401, a command that duplicated a
secret, missing sections), ROADMAP (duplicate rows, a claimed e2e test that
didn't exist), PHASE-7 demo (role at sign-up, `session.accessToken`),
ARCHITECTURE (pre-implementation plan presented as current), incomplete
`.env.example` files — all corrected. New: `SYSTEM-REFERENCE.md`,
`EVENT-SCHEMA.md`, this review.

## 3. Tests added

- **`tests/db/realPostgres.test.js` (31 tests)** — on a real PostgreSQL 16
  prepared by the project's own init script, as each service's own role:
  least-privilege checks; every Node migration applied twice (idempotent);
  Flyway V1–V3 for both Spring services; every JPA entity field ↔ column;
  dispatch races (same ambulance ×2, 10 emergencies vs 3 ambulances),
  cancel/complete/re-dispatch, duplicate plate, radius semantics, index;
  hospital seed + SQL summary + CHECK constraints + radius search; disaster
  transitions, note, concurrency, out-of-order reactions, FK; citext
  uniqueness, refresh rotation under concurrency + purge, last-admin guard.
- Geo antimeridian tests (3 services), power CRITICAL→FAILED and backdated
  reading tests, blood depleted-type, nearby-only reaction and locked
  release tests.
- `scripts/run-node-tests.sh` (every Node test file, per-file result) and
  `scripts/verify-system.sh` (13 system checks + DB suite + unit suites in
  containers).

## 4. Reviewed and left as is

- `TRUST_PROXY_HOPS` defaults differ (gateway 0, auth 1) — both correct:
  auth-service always sits behind the gateway.
- Gateway's RabbitMQ connection only feeds a health metric — kept (cheap,
  reported on dashboards).
- resilience-service `/health/ready` always 200 — it has no hard dependency;
  under Compose it intentionally serves "not in Kubernetes".
- Spring readiness doesn't report RabbitMQ details (`show-details: never`,
  Phase 12) — the broker drill checks the Node services only, by design.
- Duplicated presentational components (StatCard/BarChart per page) — working
  code; consolidating them is churn without a defect.
- See SYSTEM-REFERENCE §14 for remaining limitations.

## 5. Verification — what ran here, and what only `verify-system.sh` can confirm

The review environment could not reach npm, Maven Central, Docker Hub or
the Ubuntu archive (the egress proxy returns HTTP 403 by organisation
policy; not circumvented). So the application **images could not be built**
and Express/Spring code could not be started here. Everything that could run
for real, did:

| # | Requested check | Executed here (real components) | Needs `verify-system.sh` on a machine with registry access |
|---|---|---|---|
| 1 | Docker Compose startup | Compose file parsed and dependency/healthcheck graph checked | `docker compose up --build`, all 16 healthy |
| 2 | Database initialisation | ✅ **Real PostgreSQL 16.13**: the project's init script created 6 DBs + 6 non-superuser roles; cross-DB access denied; all migrations (Node + Flyway SQL) applied as the service roles, idempotently | — (also checked again inside Compose) |
| 3 | Authentication | ✅ auth repositories on real Postgres (citext uniqueness, concurrent rotation, purge, last-admin lock); JWT/cookie/lockout/security unit tests | login → me → cookie refresh → register → 401/403 through the gateway |
| 4 | Hospital service | ✅ seed, SQL summary = row sum, CHECK → 23514, radius search on real Postgres; capacity unit tests | HTTP endpoints |
| 5 | Ambulance service | ✅ real-transaction dispatch races (before fix: 20/20 double-assigned; after: 0), cancel/complete/re-dispatch, duplicate plate | HTTP endpoints |
| 6 | Blood service | Flyway schema + entity mapping on real Postgres; Java sources parse-checked; GeoUtils compiled and run | `mvn test`; reserve → release → second release 409 |
| 7 | Power service | same as 6; failure-episode logic covered by new unit tests | `mvn test`; CRITICAL → FAILED → recovery over HTTP |
| 8 | Disaster event flow | ✅ disaster service on real Postgres: publish call + correlationId, transitions, note, out-of-order guard | 4/4 reactions through real RabbitMQ |
| 9 | Message broker | consumer hardening reviewed; metrics unit tests | queues + consumers via `rabbitmqctl`, 6 event types in history |
| 10 | Dashboard | ✅ **Real React build in Chromium** (Playwright) at 375/768/1366 px, backed by the real hospital/ambulance/disaster/auth code on real Postgres (Express routing and password check stood in; blood/power answered 503 on purpose): 0 horizontal overflow, 0 page errors, partial-failure banners, status buttons follow fresh status | live WebSocket handshake through the gateway |
| 11 | Kubernetes deployment | ✅ **Real k3s v1.31 API server**: all 86 rendered objects accepted by server-side dry run (incl. 10 NetworkPolicies, RBAC, HPAs, the new Postgres args) | pods running on Kind with the built images |
| 12 | Monitoring | ✅ **Real Prometheus 2.54 + Alertmanager 0.27** with the project's config: 15 targets up (real metrics module), 34 rules healthy, promtool unit tests pass, 84/84 dashboard queries valid (69 with data), `SentinelServiceDown` fired and reached Alertmanager. Grafana binary unavailable (download blocked) | Grafana provisioning + datasource health |
| 13 | Failure simulation | ✅ resilience-service unit/drill suites against the fake cluster (41 tests); service-down alert path above | Compose: stop/start hospital-service; Kind: `hospital-failure` drill end to end |

Totals executed here: **262 Node tests passing** (231 unit + 31 real-Postgres),
9 Node test files skipped only for missing npm packages, 19 alert-rule tests,
110 Java files parse-clean.

Run the remaining confirmations with:

```bash
./scripts/verify-system.sh all --yes
```

It prints PASS/FAIL per check (and for the DB suite and unit suites) and
exits with the number of failures.
