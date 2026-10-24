# Phase 5 — Blood Bank Intelligence Service

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

An independent Blood Bank microservice — Java/Spring Boot, per the
original architecture decision (see `docs/ARCHITECTURE.md` section 2):
batch-level inventory tracking, FEFO reservations, transfers,
low-stock/expiry detection, aggregated shortage alerts, a **prototype**
(explicitly non-medical) demand forecasting module, dashboard charts,
and tests.

Per the phase rule, **only blood-bank-service and frontend were
touched.** Gateway needed no changes — its `blood-banks` write-role
rule (`HOSPITAL_ADMIN`, `SYSTEM_ADMIN`) was already configured in
Phase 2. auth-service, hospital-service, ambulance-service, and the
still-unbuilt power/disaster/notification services are untouched.

---

## Why Spring Boot (and what changed from the Phase 1 stub)

Phase 1 scaffolded `blood-bank-service` as a Spring Boot skeleton with
only Actuator health checks, per the architecture doc's original
Node-vs-Spring split (transactional/relational-heavy services get
Spring Boot). This phase fills that skeleton in for real: Spring
Security (JWT verification + `@PreAuthorize` role checks), Spring Data
JPA (entities + repositories), Flyway (schema migrations), Bean
Validation (`jakarta.validation` on every request DTO), and springdoc
(auto-generated OpenAPI/Swagger UI) — the Spring-idiomatic equivalent
of every pattern the Node.js services already established.

---

## Architecture

```
Browser (Blood Bank Dashboard)
  │ GET /api/v1/blood-banks/stats/summary
  │ GET /api/v1/blood-banks/low-stock
  │ GET /api/v1/blood-banks/forecast?bloodType=O+
  ▼
Gateway (:8080)
  │  requireAuth (any authenticated role can read)
  │  write methods require role in {HOSPITAL_ADMIN, SYSTEM_ADMIN} —
  │  Phase 2's existing "blood-banks" prefix rule, unchanged
  ▼
blood-bank-service (:8084, Spring Boot)
  │  JwtAuthenticationFilter + SecurityConfig — independent JWT
  │  re-verification (defense in depth, same shared secret)
  │  @PreAuthorize on controller methods for role checks
  │  controller/ -> service/ -> repository/ (Spring Data JPA)
  ▼
blood_db (Postgres) — blood_banks, blood_inventory_batches,
                       blood_reservations, blood_demand_records
                       (schema owned by Flyway, src/main/resources/db/migration/)
```

### Data model

**blood_banks** — the physical facility: name, address, lat/lng,
contact phone, `managed_by_user_id` (ownership, same pattern as
hospital-service).

**blood_inventory_batches** — inventory tracked at the **batch**
level, not one aggregated row per blood type. Each row is one donation
lot: blood group + Rh factor, units available, units reserved,
collection date, expiry date. This is the realistic model real blood
banks use (traceability, FEFO issuing) and is exactly what lets this
service track collection/expiry per the requirements rather than one
fuzzy per-type number.

**blood_reservations** — one row per reservation, referencing exactly
**one** batch (see "Reservation design" below), the requesting
hospital, status (`ACTIVE`/`RELEASED`/`FULFILLED`), and who reserved
it.

**blood_demand_records** — synthetic historical demand data (seeded)
feeding the prototype forecasting module.

### Blood group + Rh factor, not a single string

`blood_group` (`A`/`B`/`AB`/`O`) and `rh_factor` (`POSITIVE`/`NEGATIVE`)
are stored as two normalized columns rather than one `"A+"` string —
`domain/BloodType.java` combines them into the familiar display form
(`A+`, `A-`, ..., `O-`) everywhere the API surfaces it, satisfying the
8 required supported types while keeping the underlying data
queryable by ABO group alone when useful.

### Reservation design: single-batch, FEFO-selected

`ReservationService.reserveBlood` selects the **earliest-expiring**
batch (FEFO — first-expiry-first-out) that has enough available units,
and reserves entirely from it. **If no single batch covers the full
request, the reservation is rejected** (`409 INSUFFICIENT_INVENTORY`)
rather than being silently split across multiple batches. This is a
deliberate scope simplification: a multi-batch "allocation" model would
need a join table (reservation to several batches, each with its own
partial-unit count) for a modest gain in flexibility. The single-batch
model keeps the data model small and every reservation traceable to
exactly one donation lot, at the cost of occasionally requiring a
larger single donation batch or a manual split into two reservation
calls. Documented in migration `V2__create_reservations.sql` and here.

Every candidate batch is re-fetched with a **pessimistic write lock**
(`findByIdForUpdate`) immediately before checking/mutating it, so two
concurrent reservation requests against the same batch can't both read
"5 available" and both succeed reserving 4 — combined with the
entity's `@Version` optimistic-lock column as a second line of defense.

### Transfer design: multi-batch, FEFO-drawn

Unlike a reservation, `TransferService.transfer` **may** draw from
several source batches FEFO to fulfill the requested quantity — there's
no reservation-record simplicity to preserve here, just moving
physical units. One new destination batch is created per source batch
drawn from, each carrying over that source batch's original
`collectionDate` and `expiryDate` (moving blood between facilities
doesn't reset its biological expiry, and preserving the original
collection date per lot keeps donation traceability intact). The whole
operation runs in one `@Transactional` block — if the requested amount
can't be fully covered, everything rolls back rather than leaving a
partial transfer applied.

### Low-stock / expiry detection and shortage alerts

- **Low stock** (feature 6): absolute-unit thresholds (5 = warning, 2 =
  critical), not a percentage — unlike hospital-service's bed-occupancy
  ratios, blood inventory per type per bank is typically a small count
  where an absolute floor is the more meaningful signal.
- **Expiring soon** (feature 7): batches expiring within a configurable
  window (default 7 days), excluding already-expired stock.
- **Shortage alerts** (feature 9): `AlertService` combines both signals
  into one prioritized feed (critical first), the same "compute
  alerts, don't just expose raw thresholds separately" pattern
  hospital-service uses.

### The prototype demand forecasting module

`ForecastingService.predictNextPeriod` is a **simple least-squares
linear regression** over historical per-period demand, extrapolated
one period forward, clamped at zero. It is the simplest model that
produces a directionally sensible trend line — no confidence
intervals, no seasonality, no outlier handling. **Every single API
response from `GET /blood-banks/forecast` includes an explicit,
unambiguous disclaimer** (`MiscDtos.ForecastResponse.DISCLAIMER`):

> "PROTOTYPE FORECAST - for demonstration purposes only. This is a
> simple statistical model over synthetic demo data. It is NOT
> medically validated and must NOT be used for real clinical,
> operational, or inventory-procurement decisions."

The historical data itself is synthetic, seeded by `DemoDataSeeder`
(6 months x 8 blood types, loosely modeled on real-world ABO/Rh
population prevalence purely for a realistic-looking demo — not
derived from any real dataset). This is stated explicitly in the
seeder's comments, the service's Javadoc, and the API response itself
— three separate places, so the "not medically validated" framing
can't be missed or silently dropped downstream.

---

## Files created

```
services/blood-bank-service/
├── pom.xml                         (+ Security, Validation, Flyway, JJWT, springdoc)
├── src/main/resources/
│   ├── application.yml             (rewritten: Flyway, JWT secret, springdoc)
│   └── db/migration/
│       ├── V1__create_blood_banks_and_inventory.sql
│       ├── V2__create_reservations.sql
│       └── V3__create_demand_records.sql
└── src/main/java/com/sentinelcloud/bloodbank/
    ├── config/JpaAuditingConfig.java, config/SecurityConfig.java
    ├── security/JwtService.java, JwtAuthenticationFilter.java,
    │            JsonAuthenticationEntryPoint.java, AuthenticatedUser.java
    ├── domain/BloodGroup.java, RhFactor.java, BloodType.java, ReservationStatus.java
    ├── entity/BloodBank.java, BloodInventoryBatch.java, BloodReservation.java, BloodDemandRecord.java
    ├── repository/ (one per entity, Spring Data JPA)
    ├── dto/BloodBankDtos.java, InventoryDtos.java, ReservationDtos.java, MiscDtos.java
    ├── service/GeoUtils.java, BloodBankService.java, InventoryService.java,
    │           ReservationService.java, TransferService.java, AlertService.java,
    │           ForecastingService.java
    ├── controller/BloodBankController.java, ReservationController.java, AnalyticsController.java
    ├── exception/NotFoundException.java, ConflictException.java, ForbiddenException.java,
    │             GlobalExceptionHandler.java
    └── seed/DemoDataSeeder.java

services/blood-bank-service/src/test/java/com/sentinelcloud/bloodbank/
├── domain/BloodTypeTest.java
└── service/GeoUtilsTest.java, ForecastingServiceTest.java,
             InventoryServiceTest.java, ReservationServiceTest.java

frontend/src/pages/
└── BloodBankDashboard.jsx   (summary cards, inventory/low-stock/expiry charts,
                               demand trend + forecast chart, shortage alerts)

docs/
└── PHASE-5-BLOOD-BANK.md    (this file)
```

## Files modified

- `services/blood-bank-service/src/main/java/.../BloodBankServiceApplication.java` — updated Javadoc for Phase 5
- `services/blood-bank-service/Dockerfile` — jar filename bumped to match pom.xml's new version
- `services/blood-bank-service/.env.example` — added `JWT_ACCESS_SECRET`
- `frontend/src/lib/api.js` — added `fetchBloodBankSummary`, `fetchBloodBanks`, `fetchLowStock`, `fetchExpiringSoon`, `fetchShortageAlerts`, `fetchDemandForecast`
- `frontend/src/App.jsx` — added the `/blood-banks` nav link and protected route
- `docker-compose.yml` — blood-bank-service now receives `JWT_ACCESS_SECRET`
- `docs/ROADMAP.md` — Phase 5 marked done

**Not modified:** gateway, auth-service, hospital-service, ambulance-service, power-service, disaster-service, notification-service.

---

## The 9 required features

| # | Feature | Endpoint |
|---|---|---|
| 1 | Add inventory | `POST /blood-banks/{id}/inventory` |
| 2 | Update inventory | `PUT /blood-banks/inventory/{batchId}` |
| 3 | Reserve blood | `POST /blood-banks/{bloodBankId}/reservations` |
| 4 | Release reservation | `POST /blood-banks/reservations/{id}/release` |
| 5 | Transfer inventory | `POST /blood-banks/{id}/transfer` |
| 6 | Detect low inventory | `GET /blood-banks/low-stock` |
| 7 | Detect units approaching expiry | `GET /blood-banks/expiring-soon?withinDays=` |
| 8 | Search nearby blood banks | `GET /blood-banks/near?lat=&lng=&radiusKm=` |
| 9 | Generate shortage alerts | `GET /blood-banks/alerts` |

Plus `POST /blood-banks` (register), `GET /blood-banks`, `GET
/blood-banks/{id}`, `PUT /blood-banks/{id}`, `GET
/blood-banks/{id}/inventory`, `GET /blood-banks/reservations/active`,
`GET /blood-banks/forecast?bloodType=`, and `GET
/blood-banks/stats/summary` to round out a usable REST API and power
the dashboard.

---

## Exact commands to run

```bash
cd sentinelcloud
docker compose up --build
```

blood-bank-service now: waits for Postgres, Flyway runs all three
migrations, `DemoDataSeeder` seeds 3 blood banks with a deliberately
uneven inventory spread (some healthy, some low-stock, some expiring
soon, one at zero) plus 48 synthetic demand records (6 months x 8
blood types), then starts listening.

### Running the tests

```bash
cd services/blood-bank-service
mvn test
```

> **Sandbox note — more significant this phase:** this environment has
> no Maven and no npm registry access, and unlike the Node.js phases
> (where `node --check` could syntax-verify every file), there is no
> equivalent lightweight way to verify Java compiles without Maven
> actually resolving dependencies and invoking `javac`. Every file was
> written and manually reviewed line-by-line for correctness, but
> **this is materially less verified than the Node.js services in
> Phases 1-4**, which were syntax-checked file-by-file. Please run
> `mvn test` (or `mvn compile` first, to isolate compile errors from
> test failures) and send me the output — I expect to need at least
> one round of fixes given the scale of this phase and the lack of a
> compiler in this environment.
>
> Also by design: this suite covers pure functions
> (`ForecastingServiceTest`, `GeoUtilsTest`, `BloodTypeTest`) and
> service-layer logic with Mockito-mocked repositories
> (`InventoryServiceTest`, `ReservationServiceTest`) — no
> controller-level HTTP integration tests (unlike the Node.js
> services' supertest+pg-mem suites), since the Java equivalent
> (Testcontainers, a real Postgres in Docker) needs Docker, which
> isn't available in this authoring environment, and a `MockMvc`
> slice test carries meaningfully higher unverified-Spring-configuration
> risk without a compiler to check it against. Recommend adding a
> Testcontainers-based integration suite once running somewhere with
> Docker + Maven available.

---

## API documentation

- Direct: **http://localhost:8084/swagger-ui.html**
- Via gateway: **http://localhost:8080/api/v1/blood-banks/swagger-ui.html**

---

## Demonstration

```bash
HOSPITAL_ADMIN_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"hospitaladmin@example.com","password":"HospitalPass1"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

# 1. Register a blood bank
curl -s -X POST http://localhost:8080/api/v1/blood-banks/ \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Demo Blood Bank","address":"1 Demo Rd, Pune","latitude":18.52,"longitude":73.85,"contactPhone":"+91-20-0000-0000"}' \
  | tee bank.json
BANK_ID=$(python3 -c "import json;print(json.load(open('bank.json'))['bloodBank']['id'])")

# 2. Add inventory (feature 1)
curl -s -X POST http://localhost:8080/api/v1/blood-banks/$BANK_ID/inventory \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"bloodType":"O+","unitsAvailable":10,"collectionDate":"2026-08-01","expiryDate":"2026-09-15"}'

# 3. Reserve blood for a hospital (feature 3)
curl -s -X POST http://localhost:8080/api/v1/blood-banks/$BANK_ID/reservations \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"bloodType":"O+","unitsRequested":4,"hospitalId":"11111111-1111-1111-1111-111111111111","notes":"Trauma case"}' \
  | tee reservation.json
RESERVATION_ID=$(python3 -c "import json;print(json.load(open('reservation.json'))['reservation']['id'])")

# 4. Release it (feature 4)
curl -s -X POST http://localhost:8080/api/v1/blood-banks/reservations/$RESERVATION_ID/release \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"

# 5. Low stock, expiring soon, alerts (features 6, 7, 9)
curl -s http://localhost:8080/api/v1/blood-banks/low-stock -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"
curl -s "http://localhost:8080/api/v1/blood-banks/expiring-soon?withinDays=7" -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"
curl -s http://localhost:8080/api/v1/blood-banks/alerts -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"

# 6. Nearby blood banks (feature 8)
curl -s "http://localhost:8080/api/v1/blood-banks/near?lat=18.52&lng=73.85&radiusKm=15" \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"

# 7. PROTOTYPE demand forecast — note the disclaimer in the response
curl -s "http://localhost:8080/api/v1/blood-banks/forecast?bloodType=O+" -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"
```

### In the browser

1. Log in, then click **Blood Banks** in the nav.
2. Summary cards: total blood banks, total units available network-wide, low-stock type count, expiring-soon count.
3. Bar chart of current inventory by blood type, sourced from the seeded uneven spread.
4. Low-stock groups and expiring-units lists, both populated immediately from the seed data.
5. Demand trend chart — pick a blood type from the dropdown, see 6 months of (synthetic) historical demand plus the forecast point, with the disclaimer banner directly beneath it.
6. Shortage alerts feed, most severe first.

---

## Known limitations (expected at this stage)

- **No controller-level HTTP integration tests** — see the sandbox note above; pure-function and service-layer (Mockito) tests only.
- **This service was not compiled in this environment** (no Maven available) — every file was hand-reviewed but not verified by `javac`. Treat this phase as needing at least one review-and-fix pass once you run `mvn test` for real.
- **Reservations draw from exactly one batch** — a request that could be satisfied by combining several smaller batches is rejected rather than split. Documented trade-off; a multi-batch allocation model is a reasonable future enhancement.
- **The forecasting model is intentionally minimal** — simple linear regression, no seasonality/confidence intervals/outlier handling, over synthetic demo data. Repeated as an explicit disclaimer in code comments, service Javadoc, and every API response.
- **No cross-service validation of `hospitalId` in reservations** — accepted as a bare UUID, consistent with this project's loose-coupling principle (same as ambulance-service's `assignedHospitalId`).
- **No frontend UI for registering blood banks, adding inventory, or making reservations** — the dashboard is read-only/visualization-only, matching what was asked ("dashboard charts showing..."). All write operations are fully functional via the API/Swagger docs.
