# Phase 3 — Hospital Intelligence Service

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

A fully independent Hospital microservice: real persistence, the nine
required features, validation, RBAC (including per-hospital
ownership), a frontend dashboard, realistic seed data, and unit +
integration tests.

Per the phase rule, **only hospital-service and frontend were
touched.** Gateway needed no changes — its `hospitals` write-role rule
(`HOSPITAL_ADMIN`, `SYSTEM_ADMIN`) was already configured in Phase 2.
auth-service, ambulance/blood-bank/power/disaster/notification
services are untouched.

---

## Architecture

```
Browser (Hospital Dashboard)
  │ GET /api/v1/hospitals/stats/summary
  │ GET /api/v1/hospitals?page=&limit=
  │ GET /api/v1/hospitals/alerts
  ▼
Gateway (:8080)
  │  requireAuth (any authenticated role can read)
  │  write methods (POST/PUT/PATCH) additionally require
  │  role in {HOSPITAL_ADMIN, SYSTEM_ADMIN} — configured in Phase 2,
  │  unchanged here
  ▼
hospital-service (:8082)
  │  requireAuth (defense in depth, independent re-verification)
  │  requireHospitalOwnership — NEW fine-grained check the gateway
  │  can't do: a HOSPITAL_ADMIN may only write to a hospital whose
  │  managed_by_user_id is their own id; SYSTEM_ADMIN may write to any
  │  routes/hospitalRoutes.js -> services/hospitalService.js
  │      (business invariants: available <= total, capacity %, alerts)
  │  -> repositories/hospitalRepository.js (parameterized SQL)
  ▼
hospital_db (Postgres) — hospitals table
  │
  └─ (best-effort) RabbitMQ: hospital.capacity.alert published
     whenever an update leaves a hospital alert-worthy
```

### Data model

All 12 requested fields, plus operational metadata:

| Field | Type | Notes |
|---|---|---|
| id | UUID | primary key |
| name, address | text | |
| latitude, longitude | double precision | validated -90..90 / -180..180 |
| emergencyContactName, emergencyContactPhone | text | phone format-validated |
| totalBeds, availableBeds | integer | `available <= total` enforced by DB CHECK *and* service-layer logic |
| totalIcuBeds, availableIcuBeds | integer | same invariant |
| totalVentilators, availableVentilators | integer | same invariant |
| emergencyStatus | `NORMAL` / `ELEVATED` / `OVERLOADED` | explicit operator declaration, distinct from computed alerts |
| managedByUserId | UUID, nullable | which `HOSPITAL_ADMIN` owns this hospital (no cross-DB FK — see migration comment) |
| createdAt, updatedAt | timestamptz | `updatedAt` auto-maintained by trigger — this is the "last updated timestamp" requirement |

### The nine required features -> where they live

| # | Feature | Endpoint | Notes |
|---|---|---|---|
| 1 | Register hospital | `POST /hospitals` | `HOSPITAL_ADMIN`/`SYSTEM_ADMIN`; creator becomes `managedByUserId` |
| 2 | Update hospital information | `PUT /hospitals/:id` | Profile fields only — availability counters excluded on purpose (see below) |
| 3 | Update bed availability | `PATCH /hospitals/:id/beds` | Owner or `SYSTEM_ADMIN` |
| 4 | Update ICU availability | `PATCH /hospitals/:id/icu` | Same |
| 5 | Update ventilator availability | `PATCH /hospitals/:id/ventilators` | Same |
| 6 | Hospitals near a location | `GET /hospitals/near?lat=&lng=&radiusKm=` | Bounding-box pre-filter + exact Haversine cutoff, nearest-first, `distanceKm` on each result |
| 7 | Hospitals with available ICU beds | `GET /hospitals/icu-available` | Sorted most-available-first |
| 8 | Mark hospital as overloaded | `POST /hospitals/:id/overload` | `{ overloaded: true/false }` — also clears it |
| 9 | Generate capacity alerts | `GET /hospitals/alerts` | Aggregated across every hospital, CRITICAL sorted first |

Plus `GET /hospitals`, `GET /hospitals/:id`, and `GET /hospitals/stats/summary`
(the dashboard's one-call summary endpoint) to round out a usable REST API.

### Why availability counters aren't part of the general PUT

`PUT /hospitals/:id` only edits "static profile" fields (name, address,
contact, total* capacities). `availableBeds`/`availableIcuBeds`/
`availableVentilators` each have their own small, single-purpose PATCH
endpoint. This means every availability change is a minimal, auditable
request, and it keeps the invariant checks simple and localized
instead of one large schema trying to validate every field combination
at once.

### Capacity invariant enforcement (two layers)

1. **Database CHECK constraints** (migration `0001_create_hospitals.sql`) — `available_beds <= total_beds` etc. can never be violated no matter what writes the row, even a future script or a bug elsewhere.
2. **Service-layer checks** (`services/hospitalService.js`) — return a clean `409 CAPACITY_INVARIANT_VIOLATION` with a specific message *before* hitting the database, so the API gives a useful error rather than surfacing a raw Postgres constraint violation. This also catches something Postgres CHECK constraints can't: **lowering `totalBeds` below the currently available count** — caught explicitly in `updateHospitalProfile`.

### Alerts: computed vs. declared

`emergencyStatus` (`NORMAL`/`ELEVATED`/`OVERLOADED`) is something a
human explicitly sets via `POST /hospitals/:id/overload`.
`computeHospitalAlerts()` (`services/capacity.js`) independently
*computes* alert-worthiness from the numbers — a hospital can be
algorithmically critical (e.g. 2% beds free) without anyone having
flagged it `OVERLOADED` yet, and vice versa. Both feed into `GET
/hospitals/alerts`, and every hospital response includes both its raw
`emergencyStatus` and its live-computed `alerts` array.

### Geographic search without PostGIS

`GET /hospitals/near` deliberately does not use PostGIS, even though
the `postgis/postgis` Docker image is already the base for this
project's Postgres container. At this project's scale (tens of
hospitals), a plain `(latitude, longitude)` B-tree index used as a
bounding-box pre-filter, followed by an exact Haversine distance
calculation in JavaScript (`services/capacity.js`
`haversineDistanceKm`/`boundingBoxForRadius`), is simpler to read, unit
test without a live database, and reason about than
`ST_DWithin`/geography columns — while still being correct and
reasonably efficient. This is a documented, deliberate trade-off, not
an oversight; switching to PostGIS later would only mean changing
`hospitalRepository.findWithinBoundingBox` and adding a migration, not
the service's external API.

---

## Files created

```
services/hospital-service/
├── migrations/0001_create_hospitals.sql
├── src/
│   ├── db/migrate.js              (same pattern as auth-service)
│   ├── db/seed.js                 (8 realistic Pune-area sample hospitals)
│   ├── middleware/auth.js         (requireAuth, requireRole)
│   ├── middleware/ownership.js    (requireHospitalOwnership — new this phase)
│   ├── middleware/validate.js     (validateBody + validateQuery)
│   ├── schemas/hospitalSchemas.js (Zod: create/update/beds/icu/ventilators/overload/near/pagination)
│   ├── repositories/hospitalRepository.js
│   ├── services/capacity.js       (pure functions: occupancy %, alerts, Haversine — fully unit-tested)
│   ├── services/hospitalService.js (orchestration + invariants + best-effort event publish)
│   ├── routes/hospitalRoutes.js
│   └── openapi.yaml               (served via Swagger UI at /docs)
└── tests/
    ├── capacity.test.js               (pure-function unit tests)
    ├── schemas.test.js                (Zod schema unit tests)
    └── hospitalRoutes.integration.test.js  (full HTTP flow against an in-memory Postgres)

frontend/src/pages/
└── HospitalDashboard.jsx          (summary cards, alerts panel, hospital table)

docs/
└── PHASE-3-HOSPITAL.md            (this file)
```

## Files modified

- `services/hospital-service/src/db.js` — added `waitForDb()`
- `services/hospital-service/src/broker.js` — added exchange setup + `publishEvent()`
- `services/hospital-service/src/index.js` — rewritten to wire migrations, seeding, the real router, Swagger docs, structured error handling
- `services/hospital-service/package.json` — added jsonwebtoken, swagger-ui-express, yaml, zod, pg-mem + supertest (dev)
- `services/hospital-service/Dockerfile` — now also copies `migrations/`
- `services/hospital-service/.env.example` — added `JWT_ACCESS_SECRET`
- `frontend/src/lib/api.js` — added `fetchHospitalSummary`, `fetchHospitals`, `fetchHospitalAlerts`, `fetchHospitalsWithIcuAvailable`, `fetchHospitalsNear`
- `frontend/src/App.jsx` — added a nav bar and the `/hospitals` protected route
- `docker-compose.yml` — hospital-service now receives `JWT_ACCESS_SECRET`
- `docs/ROADMAP.md` — Phase 3 marked done

**Not modified:** gateway (its Phase 2 role config already covered
this), auth-service, ambulance-service, blood-bank-service,
power-service, disaster-service, notification-service.

---

## Exact commands to run

```bash
cd sentinelcloud
docker compose up --build
```

hospital-service now: waits for Postgres -> runs the migration
(creating `hospitals`, `schema_migrations`) -> seeds 8 sample hospitals
(only if the table is empty) -> starts listening. One of the seeded
hospitals (Jehangir Hospital) is pre-flagged `OVERLOADED`, and two more
(Sassoon General, Noble Hospital) have low bed/ICU availability, so the
alerts panel has real content immediately.

### Running the tests

```bash
cd services/hospital-service
npm install
npm test
```

> **Sandbox note, as in Phase 2:** these tests were written and
> syntax-checked (`node --check` on every file) without npm registry
> access in this environment, so `npm install && npm test` itself
> wasn't run end-to-end here. Run it yourself and send me any failure
> before we move to Phase 4.

---

## API documentation

- Direct: **http://localhost:8082/docs**
- Via gateway: **http://localhost:8080/api/v1/hospitals/docs**

---

## Demonstration

Assumes the stack is running and you have a `HOSPITAL_ADMIN` and a
`CITIZEN` token from Phase 2 (or register fresh ones — see
`docs/PHASE-2-AUTH.md`).

```bash
HOSPITAL_ADMIN_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"hospitaladmin@example.com","password":"HospitalPass1"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")
# (register that account first via /api/v1/auth/register with role: HOSPITAL_ADMIN if you haven't yet)

# 1. Register a hospital
curl -s -X POST http://localhost:8080/api/v1/hospitals \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Demo Hospital","address":"1 Demo Rd, Pune","latitude":18.52,"longitude":73.85,
       "emergencyContactName":"Dr. Demo","emergencyContactPhone":"+91-20-0000-0000",
       "totalBeds":50,"availableBeds":20,"totalIcuBeds":5,"availableIcuBeds":2,
       "totalVentilators":3,"availableVentilators":1}' | tee hospital.json
HOSPITAL_ID=$(python3 -c "import json;print(json.load(open('hospital.json'))['hospital']['id'])")

# 2. Update bed availability
curl -s -X PATCH http://localhost:8080/api/v1/hospitals/$HOSPITAL_ID/beds \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"availableBeds": 3}'
# -> capacity.beds jumps to 94%, alerts now include LOW_BED_AVAILABILITY (CRITICAL)

# 3. Mark it overloaded
curl -s -X POST http://localhost:8080/api/v1/hospitals/$HOSPITAL_ID/overload \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"overloaded": true}'

# 4. See it reflected in the aggregate alerts feed
curl -s http://localhost:8080/api/v1/hospitals/alerts -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"

# 5. Hospitals with ICU beds available
curl -s http://localhost:8080/api/v1/hospitals/icu-available -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"

# 6. Hospitals within 15km of central Pune
curl -s "http://localhost:8080/api/v1/hospitals/near?lat=18.52&lng=73.85&radiusKm=15" \
  -H "Authorization: Bearer $HOSPITAL_ADMIN_TOKEN"

# 7. Ownership enforcement — a DIFFERENT hospital admin cannot touch your hospital
curl -i -X PATCH http://localhost:8080/api/v1/hospitals/$HOSPITAL_ID/beds \
  -H "Authorization: Bearer $SOME_OTHER_HOSPITAL_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"availableBeds": 0}'
# -> 403 FORBIDDEN, "You do not manage this hospital."

# 8. A CITIZEN can read everything but cannot write
curl -i -X PATCH http://localhost:8080/api/v1/hospitals/$HOSPITAL_ID/beds \
  -H "Authorization: Bearer $CITIZEN_TOKEN" -H "Content-Type: application/json" -d '{"availableBeds": 0}'
# -> 403 FORBIDDEN (blocked at the gateway, per Phase 2's write-role rule)
```

### In the browser

1. Log in as any role -> click **Hospitals** in the nav.
2. Summary cards show total hospitals, available beds, ICU
   availability, overloaded count, and bed capacity % — all sourced
   from the seeded demo data on first load.
3. The alerts panel lists **Jehangir Hospital: flagged as overloaded**
   plus low-ICU/low-bed warnings from the other seeded hospitals,
   CRITICAL first.
4. The hospital table shows every seeded hospital with a live capacity
   bar per row, color-coded green/amber/red by occupancy.
5. The whole page auto-refreshes every 10 seconds, same polling
   pattern as the Phase 1 System Health dashboard.

---

## Known limitations (expected at this stage)

- **No hospital-management UI (create/edit forms) in the frontend
  yet** — the dashboard is read-only, matching exactly what was asked
  ("frontend dashboard components showing…"). Admin write actions are
  fully functional via the API/Swagger docs; a management UI can be
  added in a later phase if wanted.
- **`GET /hospitals/near` computes distance in application code**, not
  PostGIS — a deliberate scope/complexity trade-off documented above,
  fine at this data scale.
- **No pagination UI** on the frontend hospital table (loads up to 50
  at once) — matches the seed data size; would need a "load more" or
  page control once the hospital count grows meaningfully past that.
- **`managedByUserId` has no cross-database foreign key** to
  auth-service's `users` table (impossible in Postgres across separate
  databases) — referential integrity here is application-level only.
  A user that's deleted in auth-service would leave a dangling
  `managedByUserId`; not a concern yet since auth-service has no
  user-deletion endpoint.
- **No audit log of who changed what and when** beyond `updatedAt` —
  the best-effort RabbitMQ event publish is a step toward this (an
  event consumer could build an audit trail later) but nothing
  consumes those events yet.
- **`npm install && npm test` was not run in this sandbox** — same
  caveat as Phase 2; every file was syntax-checked with `node --check`
  and the logic was traced carefully, but please run the real suite
  and report back if anything fails.
