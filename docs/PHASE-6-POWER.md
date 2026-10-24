# Phase 6 — Power Infrastructure Monitoring Service

> **Note (Phases 12–13).** Commands and behaviour in this phase document
> predate the security hardening and the engineering review. Notably: sign-up
> always creates a `CITIZEN` (no `role` field), the refresh token is an
> httpOnly cookie (login returns `accessToken`, not `session.accessToken`),
> every service except `/auth/docs` requires a Bearer token, and secrets come
> from `./scripts/generate-secrets.sh`. Current commands:
> [`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md), [`../SECURITY.md`](../SECURITY.md).


> **Phase 12 note:** setup and access changed since this phase was written.
> Generate secrets with `./scripts/generate-secrets.sh` instead of copying
> `.env.example`; sign-up now always creates a `CITIZEN`; and in Docker
> Compose the application services no longer publish their own ports
> (`localhost:8081`–`8088`) — use the gateway, e.g.
> `http://localhost:8080/api/v1/<service>/…` (API docs:
> `/api/v1/auth/docs`). See [`SECURITY.md`](../SECURITY.md).

## Goal

An independent Power Infrastructure microservice — Java/Spring Boot,
per the original architecture decision (see `docs/ARCHITECTURE.md`
section 2): substation/transformer registration, telemetry ingestion,
rule-based **and** statistical anomaly detection, automatic
NORMAL/WARNING/CRITICAL/FAILED status transitions with a failure
history ledger, aggregated infrastructure alerts, overloaded /
high-temperature detection, map data, dashboard charts, and tests.

Per the phase rule, **only power-service and frontend were touched.**
Gateway needed no changes — its `power` write-role rule
(`INFRASTRUCTURE_ADMIN`, `SYSTEM_ADMIN`) and proxy target were already
configured in Phase 2/1 respectively. auth-service, hospital-service,
ambulance-service, blood-bank-service, and the still-unbuilt
disaster/notification services are untouched.

---

## Why Spring Boot (and what changed from the Phase 1 stub)

Phase 1 scaffolded `power-service` as a Spring Boot skeleton with only
Actuator health checks, per the architecture doc's Node-vs-Spring
split (transactional/relational-heavy services get Spring Boot). This
phase fills that skeleton in for real: Spring Security (JWT
verification + `@PreAuthorize` role checks), Spring Data JPA (entities
+ repositories), Flyway (schema migrations), Bean Validation
(`jakarta.validation` on every request DTO), and springdoc
(auto-generated OpenAPI/Swagger UI) — the same Spring-idiomatic set of
additions blood-bank-service received in Phase 5.

---

## Architecture

```
Browser (Power Grid Dashboard)
  │ GET /api/v1/power/stats/summary
  │ GET /api/v1/power/map
  │ GET /api/v1/power/alerts
  ▼
Gateway (:8080)
  │  requireAuth (any authenticated role can read)
  │  write methods require role in {INFRASTRUCTURE_ADMIN, SYSTEM_ADMIN} —
  │  Phase 2's existing "power" prefix rule, unchanged
  ▼
power-service (:8085, Spring Boot)
  │  JwtAuthenticationFilter + SecurityConfig — independent JWT
  │  re-verification (defense in depth, same shared secret)
  │  @PreAuthorize on controller methods for role checks
  │  controller/ -> service/ -> repository/ (Spring Data JPA)
  ▼
power_db (Postgres) — substations, transformers, transformer_readings,
                       transformer_failure_events
                       (schema owned by Flyway, src/main/resources/db/migration/)
```

### Data model

**substations** — the physical facility: name, address, lat/lng, grid
zone label, `managed_by_user_id` (ownership, same pattern as every
other domain service).

**transformers** — one row per physical transformer, owned by exactly
one substation. `rated_voltage_kv`/`rated_current_amps` are nameplate
values (the reference point percentage-deviation checks are measured
against). `status` plus a **denormalized snapshot** of the most recent
telemetry reading (`last_voltage`, `last_current_amps`,
`last_load_percentage`, `last_temperature_celsius`,
`last_reading_at`) live directly on this row — the same "latest state
+ full history in a separate table" pattern blood-bank-service uses
for `units_available` — so overloaded/high-temperature/map queries hit
simple indexed columns instead of a correlated subquery on every
request.

**transformer_readings** — the append-only telemetry ledger (feature
5, view historical readings). Every `POST
/power/transformers/{id}/telemetry` call inserts exactly one row here;
`transformers.last_*` is just a fast-read cache of the newest row.
Each row also records whether it was flagged `anomalous` and why, so a
past anomaly stays inspectable even after the transformer's live
status has since recovered.

**transformer_failure_events** — the failure history ledger. A row is
appended every time a transformer's status transitions **into**
CRITICAL or FAILED — whether triggered automatically by a telemetry
reading breaching thresholds, or an INFRASTRUCTURE_ADMIN explicitly
marking a transformer failed/offline for maintenance
(`POST /power/transformers/{id}/status`). Recovering back to
NORMAL/WARNING resolves the most recent open event (`resolved_at`)
rather than deleting it — an append-only ledger, same philosophy as
`transformer_readings`.

### Anomaly detection: two complementary mechanisms

This was the central design decision for this phase — "detect
abnormal voltage/current/temperature/load" is satisfied by **two**
independent checks run together on every telemetry submission
(`TelemetryService.recordTelemetry`), because each catches a failure
mode the other misses:

1. **`ThresholdEngine`** (rule-based, pure/no-Spring, unit-tested in
   isolation) — evaluates a reading against **this transformer's own
   rated voltage/current** (percentage deviation) and **fixed absolute
   bands** for load% and temperature:

   | Metric | Warning | Critical | Failure (auto-FAILED) |
   |---|---|---|---|
   | Voltage deviation from rated | 10% | 20% | 35% |
   | Current deviation from rated | 15% | 30% | 50% |
   | Load percentage | 85% | 100% | 150% |
   | Temperature | 65°C | 85°C | 105°C |

   The overall status for the reading is the **worst** of the four
   metric evaluations. This catches readings that are simply outside
   safe operating limits, regardless of that transformer's history.

2. **`AnomalyDetectionService`** (statistical, pure/no-Spring,
   unit-tested in isolation) — builds a rolling baseline (mean +
   population standard deviation) from **this transformer's own** last
   30 readings per metric, and flags a new reading as anomalous if
   it's ≥2.5 standard deviations from that baseline. This catches
   *drift* — a transformer whose absolute values are still technically
   inside `ThresholdEngine`'s fixed bands, but which has started
   behaving unlike its own recent history (a leading indicator of
   degradation `ThresholdEngine` alone would miss). Requires at least
   5 prior readings before it will make a claim; with fewer, it
   reports "insufficient history" rather than a false-confidence
   answer.

A reading that is statistically anomalous but still rule-normal
upgrades the transformer's status from NORMAL to WARNING (see
`TelemetryServiceTest.aStatisticallyAnomalousButRatedRangeReadingUpgradesStatusFromNormalToWarning`)
— that's the whole reason to track a per-transformer baseline
separately from fleet-wide fixed thresholds.

`DemoDataSeeder` deliberately seeds one transformer (`TXF-HDP-01`)
with a tight, stable history and then one final reading that's a small
absolute jump — comfortably inside `ThresholdEngine`'s bands, but
several standard deviations outside that transformer's own baseline —
specifically to demonstrate this on a fresh `docker compose up` with
no telemetry submission required.

### Overloaded / high-temperature detection and infrastructure alerts

- **Overloaded** (feature 6): `GET /power/transformers/overloaded` —
  transformers whose last recorded load% is at or above the warning
  band (85%).
- **High temperature** (feature 7): `GET
  /power/transformers/high-temperature` — same pattern, temperature
  ≥65°C.
- **Infrastructure alerts** (feature 4): `AlertService` combines
  overloaded + high-temperature + FAILED transformers + inspection-overdue
  transformers (no inspection within 180 days) into one
  severity-sorted feed — the same "compute alerts, don't just expose
  raw thresholds separately" pattern every other domain service's
  `AlertService` in this project uses.

### Map data (feature 8)

`GET /power/map` returns every substation's coordinates plus its
transformers' current status in one call, so the frontend can color
map pins by each substation's **worst**-status transformer
(`InfraStatus.worstOf`) without N follow-up requests per substation.
The frontend renders this as a schematic (non-tiled) SVG map — the
same deliberate scope choice the Ambulance dashboard's `FleetMap` made
in Phase 4: genuine spatial context (relative positions, status at a
glance) without adding a new runtime dependency (Leaflet) this phase
didn't otherwise need. A real slippy map is still planned for the
dedicated frontend map phase per `docs/ROADMAP.md`.

---

## Files created

```
services/power-service/
├── pom.xml                         (+ Security, Validation, Flyway, JJWT, springdoc)
├── src/main/resources/
│   ├── application.yml             (rewritten: Flyway, JWT secret, springdoc)
│   └── db/migration/
│       ├── V1__create_substations_and_transformers.sql
│       ├── V2__create_transformer_readings.sql
│       └── V3__create_transformer_failure_events.sql
└── src/main/java/com/sentinelcloud/power/
    ├── config/JpaAuditingConfig.java, config/SecurityConfig.java
    ├── security/JwtService.java, JwtAuthenticationFilter.java,
    │            JsonAuthenticationEntryPoint.java, AuthenticatedUser.java
    ├── domain/InfraStatus.java, ReadingMetric.java
    ├── entity/Substation.java, Transformer.java, TransformerReading.java,
    │          TransformerFailureEvent.java
    ├── repository/ (one per entity, Spring Data JPA)
    ├── dto/SubstationDtos.java, TransformerDtos.java, TelemetryDtos.java, MiscDtos.java
    ├── service/GeoUtils.java, ThresholdEngine.java, AnomalyDetectionService.java,
    │           SubstationService.java, TransformerService.java, TelemetryService.java,
    │           AlertService.java
    ├── controller/SubstationController.java, TransformerController.java,
    │              AnalyticsController.java
    ├── exception/NotFoundException.java, ConflictException.java, ForbiddenException.java,
    │             GlobalExceptionHandler.java
    └── seed/DemoDataSeeder.java

services/power-service/src/test/java/com/sentinelcloud/power/service/
├── ThresholdEngineTest.java          (pure rule-based thresholds — no Spring, no DB)
├── AnomalyDetectionServiceTest.java  (pure statistical anomaly detection — no Spring, no DB)
├── GeoUtilsTest.java
├── SubstationServiceTest.java        (ownership rules, Mockito-mocked repository)
└── TelemetryServiceTest.java         (status transitions, failure-event lifecycle, Mockito-mocked repositories)

frontend/src/pages/
└── PowerDashboard.jsx   (summary cards, schematic grid map, status chart,
                           telemetry trend chart, overloaded/high-temp lists, alerts)

docs/
└── PHASE-6-POWER.md    (this file)
```

## Files modified

- `services/power-service/src/main/java/.../PowerServiceApplication.java` — updated Javadoc for Phase 6
- `services/power-service/Dockerfile` — jar filename bumped to match pom.xml's new version (0.6.0)
- `services/power-service/.env.example` — added `JWT_ACCESS_SECRET`
- `frontend/src/lib/api.js` — added `fetchPowerSummary`, `fetchSubstations`,
  `fetchTransformersForSubstation`, `fetchPowerMap`, `fetchPowerAlerts`,
  `fetchOverloadedTransformers`, `fetchHighTemperatureTransformers`,
  `fetchTransformerReadings`, `fetchTransformerAnomalies`,
  `fetchTransformerFailureHistory`, `recordTransformerTelemetry`
- `frontend/src/App.jsx` — added the `/power` nav link and protected route
- `docker-compose.yml` — power-service now receives `JWT_ACCESS_SECRET`
  (previously missing entirely, since the Phase 1 stub never needed it)
- `docs/ROADMAP.md` — Phase 6 marked done, Phase 7 marked next

**Not modified:** gateway, auth-service, hospital-service,
ambulance-service, blood-bank-service, disaster-service,
notification-service.

---

## The 8 required features

| # | Feature | Endpoint |
|---|---|---|
| 1 | Add infrastructure (substation) | `POST /power/` |
| 1 | Add infrastructure (transformer) | `POST /power/{substationId}/transformers` |
| 2 | Update telemetry | `POST /power/transformers/{id}/telemetry` |
| 3 | Detect abnormal readings (one transformer) | `GET /power/transformers/{id}/anomalies` |
| 3 | Detect abnormal readings (fleet-wide) | `GET /power/anomalies` |
| 4 | Generate infrastructure alerts | `GET /power/alerts` |
| 5 | View historical readings | `GET /power/transformers/{id}/readings?limit=` |
| 6 | Identify overloaded transformers | `GET /power/transformers/overloaded` |
| 7 | Identify high-temperature transformers | `GET /power/transformers/high-temperature` |
| 8 | Display infrastructure on a map | `GET /power/map` |

Plus `GET /power/`, `GET /power/near?lat=&lng=&radiusKm=`, `GET
/power/{id}`, `PUT /power/{id}`, `GET /power/{id}/transformers`, `GET
/power/transformers/{id}`, `PUT /power/transformers/{id}`, `GET
/power/transformers/{id}/failures`, `POST
/power/transformers/{id}/status` (manual override), and `GET
/power/stats/summary` to round out a usable REST API and power the
dashboard.

---

## Exact commands to run

```bash
cd sentinelcloud
docker compose up --build
```

power-service now: waits for Postgres, Flyway runs all three
migrations, `DemoDataSeeder` seeds 3 substations and 4 transformers
across Pune — one healthy, one deliberately overloaded+hot (CRITICAL,
demonstrating features 4/6/7 immediately), one with a statistically
anomalous latest reading buried in an otherwise-stable history
(demonstrating `AnomalyDetectionService`), and one newly commissioned
transformer with no telemetry yet — then starts listening.

### Running the tests

```bash
cd services/power-service
mvn test
```

> **Sandbox note (same caveat as Phase 5):** this environment has no
> Maven and no npm registry access, so unlike the Node.js phases there
> is no lightweight way to verify Java compiles without Maven actually
> resolving dependencies and invoking `javac`. Every file was written
> and manually reviewed line-by-line for correctness — package
> declarations, imports, method signatures, and record accessor names
> were all cross-checked against their call sites — but **this is
> materially less verified than a real `mvn test` run**. Please run it
> and send me the output; I expect at most minor fixes given the scale
> of this phase.
>
> Also by design: this suite covers the two pure-logic classes that
> matter most for correctness (`ThresholdEngineTest`,
> `AnomalyDetectionServiceTest` — the actual anomaly-detection rules,
> with zero Spring/DB involved) plus service-layer logic with
> Mockito-mocked repositories (`SubstationServiceTest`,
> `TelemetryServiceTest` — status transitions and the failure-event
> open/resolve lifecycle) and `GeoUtilsTest`. No controller-level HTTP
> integration tests, for the same Testcontainers/Docker-availability
> reason documented in Phase 5.

---

## API documentation

- Direct: **http://localhost:8085/swagger-ui.html**
- Via gateway: **http://localhost:8080/api/v1/power/swagger-ui.html**

---

## Demonstration

```bash
INFRA_ADMIN_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"infraadmin@example.com","password":"InfraPass1"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

# 1. Register a substation (feature 1)
curl -s -X POST http://localhost:8080/api/v1/power/ \
  -H "Authorization: Bearer $INFRA_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Demo Substation","address":"1 Demo Rd, Pune","latitude":18.52,"longitude":73.85,"gridZone":"Demo Zone"}' \
  | tee substation.json
SUBSTATION_ID=$(python3 -c "import json;print(json.load(open('substation.json'))['substation']['id'])")

# 2. Add a transformer (feature 1)
curl -s -X POST http://localhost:8080/api/v1/power/$SUBSTATION_ID/transformers \
  -H "Authorization: Bearer $INFRA_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"code":"TXF-DEMO-01","name":"Demo Transformer","ratedVoltageKv":33,"ratedCurrentAmps":400,"lastInspectionDate":"2026-06-01"}' \
  | tee transformer.json
TRANSFORMER_ID=$(python3 -c "import json;print(json.load(open('transformer.json'))['transformer']['id'])")

# 3. Update telemetry (feature 2) — a normal reading
curl -s -X POST http://localhost:8080/api/v1/power/transformers/$TRANSFORMER_ID/telemetry \
  -H "Authorization: Bearer $INFRA_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"voltage":33.1,"currentAmps":390,"loadPercentage":60,"temperatureCelsius":42}'

# 4. Update telemetry again — push it into overload/high-temp territory
curl -s -X POST http://localhost:8080/api/v1/power/transformers/$TRANSFORMER_ID/telemetry \
  -H "Authorization: Bearer $INFRA_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"voltage":33.1,"currentAmps":520,"loadPercentage":112,"temperatureCelsius":91}'

# 5. Detect abnormal readings (feature 3)
curl -s http://localhost:8080/api/v1/power/transformers/$TRANSFORMER_ID/anomalies \
  -H "Authorization: Bearer $INFRA_ADMIN_TOKEN"

# 6. Generate infrastructure alerts (feature 4)
curl -s http://localhost:8080/api/v1/power/alerts -H "Authorization: Bearer $INFRA_ADMIN_TOKEN"

# 7. View historical readings (feature 5)
curl -s "http://localhost:8080/api/v1/power/transformers/$TRANSFORMER_ID/readings?limit=10" \
  -H "Authorization: Bearer $INFRA_ADMIN_TOKEN"

# 8. Overloaded / high-temperature (features 6, 7)
curl -s http://localhost:8080/api/v1/power/transformers/overloaded -H "Authorization: Bearer $INFRA_ADMIN_TOKEN"
curl -s http://localhost:8080/api/v1/power/transformers/high-temperature -H "Authorization: Bearer $INFRA_ADMIN_TOKEN"

# 9. Map data (feature 8)
curl -s http://localhost:8080/api/v1/power/map -H "Authorization: Bearer $INFRA_ADMIN_TOKEN"

# 10. Failure history (opened automatically by step 4's threshold breach)
curl -s http://localhost:8080/api/v1/power/transformers/$TRANSFORMER_ID/failures \
  -H "Authorization: Bearer $INFRA_ADMIN_TOKEN"
```

### In the browser

1. Log in, then click **Power Grid** in the nav.
2. Summary cards: total substations, total transformers, overloaded
   count, high-temperature count, open alerts count.
3. Schematic grid map — substations plotted by lat/lng, pins colored
   by worst transformer status, from the seeded scenarios.
4. Transformers-by-status bar chart and a telemetry trend line chart
   (pick a transformer from the dropdown to see its recent load%
   history).
5. Overloaded and high-temperature transformer lists, populated
   immediately from the seeded `TXF-SHV-02` scenario.
6. Infrastructure alerts feed, most severe first.

---

## Known limitations (expected at this stage)

- **No controller-level HTTP integration tests** — see the sandbox
  note above; pure-function and service-layer (Mockito) tests only.
- **This service was not compiled in this environment** (no Maven
  available) — every file was hand-reviewed but not verified by
  `javac`. Treat this phase as needing at least one review-and-fix
  pass once you run `mvn test` for real.
- **Thresholds are fixed, fleet-wide constants** (`ThresholdEngine`) —
  a real deployment would likely make warning/critical/failure bands
  configurable per transformer class (distribution vs. step-up, etc.)
  rather than one set of percentages for every transformer. Documented
  as a clear future-enhancement point.
- **The statistical baseline is a simple rolling mean/std-dev over the
  last 30 readings** — no seasonality (e.g. expected daily load
  curves), no trend-awareness, no multivariate correlation between
  metrics. It answers "is this unusual for this transformer" in
  isolation per metric, which is the right scope for "a basic anomaly
  detection mechanism" as requested, but is explicitly not a
  production-grade predictive-maintenance model.
- **No `POWER_INFRASTRUCTURE_AT_RISK` event publishing yet** — per
  `docs/ARCHITECTURE.md`, that event fires in reaction to
  `disaster.detected`, which is Disaster Service's job (Phase 7, not
  yet built). This phase only produces the underlying alert data the
  future publisher will consume; RabbitMQ dependencies are already
  wired (matching blood-bank-service's identical current state) but
  unused until Phase 7 lands.
- **No frontend UI for registering substations/transformers or
  submitting telemetry** — the dashboard is read-only/visualization-only,
  matching what was asked ("charts showing telemetry trends"). All
  write operations are fully functional via the API/Swagger docs.
