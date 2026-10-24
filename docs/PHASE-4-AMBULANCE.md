# Phase 4 — Ambulance & Emergency Response Service

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

An independent Ambulance microservice: fleet management, the full
emergency dispatch workflow (find, rank, recommend, assign, publish),
a realistic route-distance/ETA model, RBAC, a frontend map
visualization, seed data, and tests.

Per the phase rule, **only ambulance-service and frontend were
touched.** Gateway needed no changes — its `ambulances` write-role rule
(`EMERGENCY_OPERATOR`, `SYSTEM_ADMIN`) was already configured in Phase
2, and emergency endpoints are nested under `/api/v1/ambulances/
emergencies/*` specifically so that rule covers them too without any
gateway edits (see "Routing design" below). auth-service,
hospital-service, blood-bank/power/disaster/notification services are
untouched.

---

## Architecture

```
Browser (Ambulance Dashboard)
  │ GET /api/v1/ambulances/stats/summary
  │ GET /api/v1/ambulances?page=&limit=
  │ GET /api/v1/ambulances/emergencies/active
  ▼
Gateway (:8080)
  │  requireAuth (any authenticated role can read)
  │  write methods additionally require role in
  │  {EMERGENCY_OPERATOR, SYSTEM_ADMIN} — Phase 2's existing
  │  "ambulances" prefix rule, unchanged, and it also covers
  │  /ambulances/emergencies/* since that's still prefix "ambulances"
  ▼
ambulance-service (:8083)
  │  requireAuth (defense in depth)
  │  routes/ambulanceRoutes.js and routes/emergencyRoutes.js
  │    -> services/dispatchService.js
  │       (find, rank, recommend, assign, publish — the actual workflow)
  │    -> services/ambulanceService.js
  │    -> services/emergencyService.js
  │    -> services/routing.js, statusMachine.js
  │       (pure functions, fully unit-tested)
  │  -> repositories/ (parameterized SQL)
  ▼
ambulance_db (Postgres) — ambulances, emergencies tables
  │
  └─ (best-effort) RabbitMQ: ambulance.dispatched / emergency.resolved /
     emergency.unassigned published on the sentinelcloud.events exchange
```

### Routing design: emergencies nested under `/ambulances`

Rather than adding a new gateway-level `emergencies` prefix (which
would need a Phase-2 gateway edit — a new proxy target and a new
write-role entry), the emergency router is mounted inside
ambulance-service itself at `/emergencies`. The gateway already proxies
everything under `/api/v1/ambulances/*` to this service's root, so
`/api/v1/ambulances/emergencies/*` reaches it with zero gateway
changes, and the existing `ambulances` write-role rule
(`EMERGENCY_OPERATOR`/`SYSTEM_ADMIN`) applies uniformly to both
resources. Worth knowing about if a future phase wants `emergencies` to
be a first-class top-level resource with different permissions than
ambulances — at that point it would earn its own gateway prefix.

### Data model

**ambulances** — all 9 requested fields, plus operational metadata:

| Field | Type | Notes |
|---|---|---|
| id | UUID | primary key |
| vehicleNumber | text, unique | |
| latitude, longitude | double precision | "location" |
| status | one of 7 enum values | see state machine below |
| driverName, driverPhone | text | "driver" |
| equipmentLevel | `BASIC` / `ADVANCED` / `CRITICAL_CARE` | "medical equipment level" |
| assignedHospitalId | UUID, nullable | cross-service reference, no FK (separate database) |
| assignedEmergencyId | UUID, nullable, FK -> emergencies.id | "assigned emergency" |
| createdAt, updatedAt | timestamptz | `updatedAt` auto-maintained by trigger — the "last updated timestamp" requirement |

**emergencies** — the entity the dispatch workflow operates on (see
"Scope of emergency in this phase" below):

| Field | Type | Notes |
|---|---|---|
| id, description, latitude, longitude | | where and what |
| severity | `LOW`/`MEDIUM`/`HIGH`/`CRITICAL` | |
| status | `ACTIVE`/`ASSIGNED`/`RESOLVED`/`CANCELLED` | |
| assignedAmbulanceId | UUID, FK -> ambulances.id, nullable | |
| assignedHospitalId | UUID, nullable | cross-service, no FK |
| createdByUserId | UUID | who reported it |
| createdAt, updatedAt, resolvedAt | | |

The two tables reference each other (`ambulances.assigned_emergency_id`
and `emergencies.assigned_ambulance_id`), so migration `0001` declares
the ambulances column without its FK, migration `0002` creates
emergencies (which *can* FK to the now-existing `ambulances` table),
then adds the deferred FK back onto `ambulances` via `ALTER TABLE` —
documented inline in both migration files.

### Scope of "emergency" in this phase

`emergencies` here is intentionally narrow: it exists to answer "where
does an ambulance need to go, and has one been sent." It is **not**
the full Disaster/Event Intelligence Service from the original
architecture doc (that coordinates hospitals, blood banks, and power
infrastructure together, and is a later phase). This is called out
explicitly in the migration comment so it isn't mistaken for scope
creep into Phase 6+ territory — this phase only needed enough of an
"emergency" concept for ambulance dispatch to have somewhere to
dispatch to.

### The 9 required features

| # | Feature | Endpoint |
|---|---|---|
| 1 | Register ambulance | `POST /ambulances` |
| 2 | Update location | `PATCH /ambulances/:id/location` |
| 3 | Change status | `PATCH /ambulances/:id/status` (state-machine enforced) |
| 4 | Dispatch ambulance | `POST /ambulances/:id/dispatch` (manual) + automatic on emergency creation |
| 5 | Assign hospital | `PATCH /ambulances/:id/assign-hospital` |
| 6 | Complete emergency | `POST /ambulances/emergencies/:id/complete` |
| 7 | Find nearest available ambulance | `GET /ambulances/nearest?lat=&lng=&radiusKm=&limit=` |
| 8 | Calculate estimated response time | `distanceKm`/`etaMinutes` on every `/nearest` and dispatch result |
| 9 | Track active emergencies | `GET /ambulances/emergencies/active` |

Plus `GET /ambulances`, `GET /ambulances/:id`, `PUT /ambulances/:id`,
`GET /ambulances/stats/summary`, `POST /ambulances/emergencies` (the
dispatch-workflow entry point), `GET /ambulances/emergencies`, `GET
/ambulances/emergencies/:id`, and `POST /ambulances/emergencies/:id/cancel`
to round out a usable REST API.

### Ambulance status state machine

```
AVAILABLE --dispatch--> DISPATCHED --> EN_ROUTE --> AT_SCENE --> TRANSPORTING --> AT_HOSPITAL --> AVAILABLE
    |                       |                                        |
    |                       +--stand down--> AVAILABLE                +--patient refused--> AVAILABLE
    |
    +-- any active status --> OUT_OF_SERVICE --> AVAILABLE
```

Enforced by `services/statusMachine.js` (`isValidStatusTransition`), a
single source of truth used both by the general `PATCH /:id/status`
endpoint *and* internally by the dispatch/complete-emergency workflows
— nothing bypasses it. An illegal request (e.g. `AVAILABLE` straight to
`AT_HOSPITAL`) returns `409 INVALID_STATUS_TRANSITION` naming the
actual allowed next states.

### The dispatch workflow, exactly as requested

`POST /ambulances/emergencies` does all five requested steps in one
call, inside `services/dispatchService.js`:

1. **Find** — `ambulanceRepository.findAvailableWithinBoundingBox`, a coarse indexed pre-filter within a 50km box of the emergency
2. **Rank** — each candidate gets a realistic road-distance + ETA (see below), sorted nearest-first
3. **Recommend** — the top-ranked candidate is the recommendation, returned in the response as `recommendation` even when nothing is auto-assigned
4. **Assign** — `dispatchAmbulanceToEmergency` sets the ambulance to `DISPATCHED`, links both records
5. **Publish** — `ambulance.dispatched` published on the `sentinelcloud.events` exchange (best-effort — see below)

If no ambulance is available in range, the emergency is still created
and stays `ACTIVE` (`recommendation: null`), ready for manual dispatch
via `POST /ambulances/:id/dispatch` once something frees up, or a retry
once a unit re-enters the search radius.

### Realistic route-distance algorithm

`services/routing.js` documents this explicitly rather than presenting
it as precision routing:

- **Road distance** = straight-line (Haversine) distance times **1.3** — a commonly-cited detour-index approximation for how much longer real road paths are than a straight line in mixed urban/suburban terrain.
- **ETA** = (road distance divided by 55 km/h assumed emergency-vehicle average speed) plus a fixed **90-second dispatch turnout time** (the real, measurable gap between a dispatch order and the ambulance actually rolling).

This intentionally avoids a paid routing API (Google Directions,
OSRM-with-map-data hosting) per this project's "no paid cloud services"
principle (see `docs/ARCHITECTURE.md`) while still being a genuine,
explainable distance model rather than naive straight-line distance —
the same reasoning `hospital-service`'s `GET /hospitals/near` already
used, applied consistently here.

### Best-effort event publishing

Same pattern as `hospital-service`: a RabbitMQ publish failure never
fails the underlying request. `dispatchService.publishBestEffort` logs
a warning and moves on — the ambulance is dispatched and persisted
regardless of whether the event fan-out succeeded. `/health/ready`
therefore only requires Postgres, not RabbitMQ, matching
`hospital-service`'s identical readiness design.

---

## Files created

```
services/ambulance-service/
├── migrations/
│   ├── 0001_create_ambulances.sql
│   └── 0002_create_emergencies.sql   (+ the deferred FK back onto ambulances)
├── src/
│   ├── db/migrate.js, db/seed.js
│   ├── middleware/auth.js, middleware/validate.js
│   ├── schemas/ambulanceSchemas.js, schemas/emergencySchemas.js
│   ├── repositories/ambulanceRepository.js, repositories/emergencyRepository.js
│   ├── services/routing.js         (pure: Haversine, road distance, ETA — unit-tested)
│   ├── services/statusMachine.js   (pure: legal-transition table — unit-tested)
│   ├── services/ambulanceService.js
│   ├── services/dispatchService.js (the 5-step workflow)
│   ├── services/emergencyService.js
│   ├── routes/ambulanceRoutes.js, routes/emergencyRoutes.js
│   └── openapi.yaml
└── tests/
    ├── routing.test.js
    ├── statusMachine.test.js
    ├── schemas.test.js
    └── dispatch.integration.test.js  (full HTTP flow, in-memory Postgres)

frontend/src/pages/
└── AmbulanceDashboard.jsx  (summary cards, SVG fleet map, active-emergency feed)

docs/
└── PHASE-4-AMBULANCE.md    (this file)
```

## Files modified

- `frontend/src/lib/api.js` — added `fetchAmbulanceSummary`, `fetchAmbulances`, `fetchActiveEmergencies`
- `frontend/src/App.jsx` — added the `/ambulances` nav link and protected route
- `docker-compose.yml` — ambulance-service now receives `JWT_ACCESS_SECRET`
- `docs/ROADMAP.md` — Phase 4 marked done

**Not modified:** gateway, auth-service, hospital-service,
blood-bank-service, power-service, disaster-service,
notification-service.

---

## Exact commands to run

```bash
cd sentinelcloud
docker compose up --build
```

ambulance-service now: waits for Postgres, runs both migrations
(creating `ambulances`, `emergencies`, `schema_migrations`), seeds 10
sample ambulances (8 `AVAILABLE`, 1 `OUT_OF_SERVICE`, 1 `AT_HOSPITAL`)
and 1 demo emergency (left `ACTIVE`/unassigned on purpose, so "track
active emergencies" has something to show immediately without first
triggering a dispatch), then starts listening.

### Running the tests

```bash
cd services/ambulance-service
npm install
npm test
```

> **Sandbox note, as in prior phases:** written and syntax-checked
> (`node --check` on every file) without npm registry access in this
> environment — `npm install && npm test` wasn't run end-to-end here.
> Run it yourself and report back anything that fails before Phase 5.

---

## API documentation

- Direct: **http://localhost:8083/docs**
- Via gateway: **http://localhost:8080/api/v1/ambulances/docs**

---

## Demonstration

```bash
OPERATOR_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@example.com","password":"OperatorPass1"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")
# (register that account first with role: EMERGENCY_OPERATOR if needed)

# 1. Register an ambulance
curl -s -X POST http://localhost:8080/api/v1/ambulances \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"vehicleNumber":"MH12-DEMO-01","latitude":18.52,"longitude":73.85,
       "driverName":"Demo Driver","driverPhone":"+91-98765-00000","equipmentLevel":"ADVANCED"}'

# 2. Report an emergency — the full auto-dispatch workflow runs in this one call
curl -s -X POST http://localhost:8080/api/v1/ambulances/emergencies \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"Cardiac arrest reported, Karve Road","latitude":18.521,"longitude":73.851,"severity":"CRITICAL"}' \
  | tee emergency.json
# Response includes: emergency.status = "ASSIGNED", recommendation.{ambulanceId,distanceKm,etaMinutes},
# and ambulance.status = "DISPATCHED"

EMERGENCY_ID=$(python3 -c "import json;print(json.load(open('emergency.json'))['emergency']['id'])")
AMBULANCE_ID=$(python3 -c "import json;print(json.load(open('emergency.json'))['ambulance']['id'])")

# 3. Walk the ambulance through its real lifecycle
curl -s -X PATCH http://localhost:8080/api/v1/ambulances/$AMBULANCE_ID/status \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{"status":"EN_ROUTE"}'
curl -s -X PATCH http://localhost:8080/api/v1/ambulances/$AMBULANCE_ID/status \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{"status":"AT_SCENE"}'
curl -s -X PATCH http://localhost:8080/api/v1/ambulances/$AMBULANCE_ID/status \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{"status":"TRANSPORTING"}'

# 4. Assign a destination hospital (use a real id from GET /api/v1/hospitals)
curl -s -X PATCH http://localhost:8080/api/v1/ambulances/$AMBULANCE_ID/assign-hospital \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"hospitalId":"<a real hospital id>"}'

curl -s -X PATCH http://localhost:8080/api/v1/ambulances/$AMBULANCE_ID/status \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{"status":"AT_HOSPITAL"}'

# 5. Illegal jumps are rejected with a clear 409 — try this on a FRESH ambulance
#    right after registering it (status AVAILABLE):
curl -i -X PATCH http://localhost:8080/api/v1/ambulances/<fresh-ambulance-id>/status \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{"status":"AT_HOSPITAL"}'
# -> 409 INVALID_STATUS_TRANSITION, message lists the actual allowed next states

# 6. Complete the emergency — resolves it, frees the ambulance back to AVAILABLE
curl -s -X POST http://localhost:8080/api/v1/ambulances/emergencies/$EMERGENCY_ID/complete \
  -H "Authorization: Bearer $OPERATOR_TOKEN"

# 7. Track active emergencies
curl -s http://localhost:8080/api/v1/ambulances/emergencies/active -H "Authorization: Bearer $OPERATOR_TOKEN"

# 8. Nearest-ambulance search directly (features 7 & 8 in isolation)
curl -s "http://localhost:8080/api/v1/ambulances/nearest?lat=18.52&lng=73.85&radiusKm=20" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

### In the browser

1. Log in, then click **Ambulances** in the nav.
2. Summary cards show the fleet broken down by every status, plus a
   live active-emergency count.
3. The fleet map plots every seeded ambulance as a colored dot
   (color = status, per the legend) and the seeded demo emergency as a
   ringed "!" marker — hover any marker for details.
4. The active-emergencies panel lists the seeded "Multi-vehicle
   collision" report, flagged "Awaiting dispatch" since it was seeded
   unassigned on purpose.
5. Trigger a real dispatch via `curl` (step 2 above) or the Swagger UI,
   then watch the map and panel update on the next 8-second poll — the
   newly `DISPATCHED` ambulance changes color live.

---

## Known limitations (expected at this stage)

- **The fleet map is schematic, not a real tiled map.** Positions are
  plotted by normalized lat/lng within an SVG viewBox, not
  OpenStreetMap tiles — a deliberate scope choice to avoid adding a new
  runtime dependency (Leaflet) this phase didn't otherwise need. A real
  slippy map is still planned for a later frontend-focused phase per
  `docs/ROADMAP.md`, and nothing here would need to change in the
  backend to support it — only the frontend rendering.
- **No frontend UI yet for registering ambulances, reporting
  emergencies, or walking a status through its lifecycle** — the
  dashboard is read-only/visualization-only, matching what was asked
  ("frontend visualization of ambulances on a map"). All of that is
  fully functional via the API/Swagger docs.
- **`assignedHospitalId` is not validated against hospital-service** —
  accepted as a bare UUID at face value, no live cross-service check
  that the hospital actually exists. Consistent with this project's
  loose-coupling principle (each service owns its own data
  independently); a real system might validate this via an
  event-driven eventual-consistency check rather than a synchronous
  HTTP call that would create a hard runtime dependency between
  services.
- **No ownership model on ambulances** (unlike hospital-service's
  per-admin ownership) — any `EMERGENCY_OPERATOR` can manage any
  ambulance, which matches how a shared EMS fleet is actually
  coordinated in practice, but is a deliberate difference from Phase
  3's design worth knowing about if compared side-by-side.
- **Route distance is a documented approximation** (1.3x Haversine),
  not a real routing engine — see "Realistic route-distance algorithm"
  above for the full reasoning.
- **`npm install && npm test` was not run in this sandbox** — same
  caveat as every prior phase; every file was syntax-checked with
  `node --check` and the logic traced carefully, but please run the
  real suite and report back if anything fails.
