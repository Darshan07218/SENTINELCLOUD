# Phase 7 — Disaster/Event Intelligence Service & Event-Driven Response Engine

> **Note (Phases 12–13).** Commands and behaviour in this phase document
> predate the security hardening and the engineering review. Notably: sign-up
> always creates a `CITIZEN` (no `role` field), the refresh token is an
> httpOnly cookie (login returns `accessToken`, not `session.accessToken`),
> every service except `/auth/docs` requires a Bearer token, and secrets come
> from `./scripts/generate-secrets.sh`. Current commands:
> [`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md), [`../SECURITY.md`](../SECURITY.md).


## Goal

A Disaster/Event microservice that publishes `disaster.detected` /
`disaster.updated` onto the shared message bus, and REAL event-driven
reactions in four already-built services — Hospital, Ambulance, Blood
Bank, Power — with no synchronous service-to-service calls anywhere in
this flow. A fan-in aggregator turns the resulting reaction events
into a per-disaster situation report, and a live WebSocket dashboard
shows the whole thing happening in real time.

Per the phase rule, every service this phase touches got the smallest
change that made it react: **disaster-service** is new; **hospital-service**,
**ambulance-service**, **blood-bank-service**, **power-service**, and
**notification-service** each gained a consumer (or, for
notification-service, a rewritten fan-out) with no changes to their
existing REST APIs or business logic; **gateway** and **docker-compose.yml**
gained the wiring a new service and a new REST proxy target need.
auth-service is untouched.

---

## Why this is event-driven, not synchronous

The spec was explicit: **"Demonstrate event-driven architecture rather
than direct synchronous calls wherever appropriate."** Concretely, that
means:

- `disaster-service` never calls Hospital/Ambulance/Blood
  Bank/Power's REST APIs. It publishes one message and returns.
- Hospital/Ambulance/Blood Bank/Power never call `disaster-service`'s
  API either. Each independently consumes its own queue and reacts
  entirely on its own schedule.
- The four reacting services don't know about each other. Not one line
  of hospital-service's code mentions ambulance-service, and vice
  versa. They're coupled only through the shared exchange and a
  well-known routing-key vocabulary (`docs/ARCHITECTURE.md` section 4).
- If Hospital Service is down when a disaster is detected, the
  disaster is still recorded, `DISASTER_DETECTED` still publishes, and
  Ambulance/Blood Bank/Power still react — RabbitMQ holds the message
  in `q.hospital.disaster-events` (durable queue, persistent message)
  until Hospital Service comes back and consumes it. A synchronous
  call chain would have no equivalent to "come back later and it still
  works."
- `disaster-service`'s reaction-aggregator and notification-service's
  live feed **both** learn about every reaction the same way — by
  consuming events — not by disaster-service polling four REST APIs
  or notification-service being told what to broadcast.

The one deliberate synchronous-looking thing in this phase is that
each reacting service's consumer *calls its own service's existing
business logic directly* (e.g. hospital-service's consumer calls
`hospitalService.findHospitalsNear(...)` in-process). That's not a
network call — it's the same function the REST controller calls,
invoked from a different trigger. Reusing it here means the "check
nearby hospitals" logic has exactly one implementation, exercised by
both a human hitting `GET /hospitals/near` and an automatic disaster
reaction — not two implementations that could drift apart.

---

## Event schema

Every message on the bus (`docs/ARCHITECTURE.md` section 4.2) is a
JSON envelope:

```json
{
  "eventId": "a1b2c3d4-...",
  "eventType": "disaster.detected",
  "occurredAt": "2026-09-19T10:15:00.000Z",
  "sourceService": "disaster-service",
  "correlationId": "f47ac10b-...",
  "payload": { "...": "event-specific fields" }
}
```

`correlationId` is the mechanism that ties an entire disaster's
reaction chain together — **it's always the disaster's own id.**
`disasterService.js` sets it when publishing `disaster.detected`;
every reacting service's consumer reads `envelope.correlationId` (or
falls back to `payload.disasterId`) and re-publishes its own reaction
under that same correlationId. `disaster-service`'s reaction-aggregator
and the frontend's live feed both use it to answer "which disaster did
this event happen because of" — no shared database table, no
synchronous lookup, just the same id carried on every message in the
chain.

### Disaster fields (as stored and returned by the API)

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `type` | enum | `FLOOD`, `FIRE`, `EARTHQUAKE`, `CYCLONE`, `LANDSLIDE`, `INDUSTRIAL_ACCIDENT` |
| `severity` | enum | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `latitude` / `longitude` | number | epicenter |
| `radiusKm` | number | affected-zone radius — every reacting service's "near this point" query uses this |
| `description` | string | |
| `status` | enum | `ACTIVE`, `CONTAINED`, `RESOLVED` |
| `occurredAt` / `createdAt` / `updatedAt` | timestamp | |

### Routing keys (`docs/ARCHITECTURE.md` section 4.1, unchanged from the original design)

| Routing key | Published by | Consumed by |
|---|---|---|
| `disaster.detected` | disaster-service | hospital, ambulance, blood-bank, power (each independently) |
| `disaster.updated` | disaster-service | same four — handled identically to `disaster.detected` |
| `hospital.capacity.updated` | hospital-service | disaster-service (aggregator), notification-service |
| `ambulance.status.updated` | ambulance-service | disaster-service (aggregator), notification-service |
| `blood.shortage.detected` | blood-bank-service | disaster-service (aggregator), notification-service |
| `power.infrastructure.at_risk` | power-service | disaster-service (aggregator), notification-service |

All six routing keys live on one topic exchange, `sentinelcloud.events`
— the same exchange every service's `broker.js`/`RabbitConfig.java`
already asserted from earlier phases.

### Queues

| Queue | Bound to | Owner |
|---|---|---|
| `q.hospital.disaster-events` | `disaster.detected`, `disaster.updated` | hospital-service |
| `q.ambulance.disaster-events` | `disaster.detected`, `disaster.updated` | ambulance-service |
| `q.bloodbank.disaster-events` | `disaster.detected`, `disaster.updated` | blood-bank-service |
| `q.power.disaster-events` | `disaster.detected`, `disaster.updated` | power-service |
| `q.disaster.reaction-aggregator` | all 4 reaction routing keys | disaster-service |
| `q.notifications.all-events` | `#` (everything) | notification-service |

Every queue is durable and every publish is persistent, so a service
restart doesn't lose in-flight events — RabbitMQ redelivers on
reconnect.

---

## What each service does now

### disaster-service (new)

- `POST /disasters` — create a disaster. Persists it, then publishes
  `disaster.detected` with the disaster's own id as `correlationId`.
  Publishing is **not** silently best-effort here the way a routine
  capacity alert is elsewhere in this project — a disaster with no
  event published is a much bigger problem, so publish failures are
  logged at error level and surfaced in the response as
  `eventPublished: false`.
- `PUT /disasters/:id`, `POST /disasters/:id/status` — update
  severity/radius/description or transition status
  (ACTIVE→CONTAINED→RESOLVED); both republish `disaster.updated`,
  which every reacting service treats identically to `disaster.detected`
  (a fresh reaction cycle, e.g. because the radius widened).
- `GET /disasters`, `/disasters/active`, `/disasters/near`, `/disasters/:id`
  — standard CRUD/geo reads.
- `GET /disasters/:id/situation-report` — the fan-in read side. Reads
  whatever rows `reactionConsumer.js` has stored in `disaster_reactions`
  for this disaster and assembles them into one report via the pure
  `situationReportService.buildSituationReport()` function. A disaster
  queried the instant after creation, before any service has reacted,
  still returns a valid report — every section just says "awaiting
  response" instead of erroring.
- `reactionConsumer.js` — binds `q.disaster.reaction-aggregator` to all
  four reaction routing keys and **upserts** each into
  `disaster_reactions` keyed by `(disaster_id, event_type, source_service)`.
  Upsert (not insert) matters because RabbitMQ's at-least-once delivery
  means a redelivered reaction shouldn't accumulate as a duplicate row
  — the situation report should show each service's *latest* reaction.

### hospital-service (`consumers/disasterConsumer.js`, new)

Binds `q.hospital.disaster-events`. On `disaster.detected`/`disaster.updated`,
calls `hospitalService.findHospitalsNear(lat, lng, radiusKm)` — **the
exact same function `GET /hospitals/near` already calls** — then
publishes `hospital.capacity.updated` with the nearby hospital list and
aggregated bed/ICU/ventilator totals, correlationId = the disaster's id.

### ambulance-service (`consumers/disasterConsumer.js`, new)

Binds `q.ambulance.disaster-events`. Calls
`ambulanceService.findNearestAvailable(lat, lng, { radiusKm, limit: 20 })`
— the same function `GET /ambulances/near-available` uses — and
publishes `ambulance.status.updated` with the available-ambulance list.
Deliberately does **not** auto-dispatch anything; it reports what's
available. Actually assigning a specific ambulance stays the
human/operator action it already was via `dispatchService.js`.

### blood-bank-service (`event/DisasterEventListener.java`, new)

`@RabbitListener(queues = "q.bloodbank.disaster-events")`. Calls
`BloodBankService.findNearby(lat, lng, radiusKm)` (same as
`GET /blood-banks/near`) **and** `AlertService.generateAlerts()` (same
as `GET /blood-banks/alerts`) — the shortage feed is network-wide
rather than radius-scoped, because a disaster response may need to
pull blood from banks outside the immediate radius, so a shortage
anywhere in the network is relevant. Publishes `blood.shortage.detected`.

### power-service (`event/DisasterEventListener.java`, new)

`@RabbitListener(queues = "q.power.disaster-events")`. Calls
`SubstationService.findNearby(lat, lng, radiusKm)` (same as
`GET /power/near`), then enriches each nearby substation with its
transformers' current status via `TransformerService.listForSubstation`
— the same data `GET /power/map` assembles — so responders know not
just where the infrastructure is but whether it's already degraded.
Publishes `power.infrastructure.at_risk`.

Both Java listeners share the same small `event/` package shape:
`EventEnvelope` (incoming, payload as `JsonNode`), `OutgoingEvent` +
`EventPublisher` (outgoing, via `RabbitTemplate`), and a `RabbitConfig`
that declares the exchange/queue/bindings and a
`Jackson2JsonMessageConverter` (Spring Boot auto-wires any single
`MessageConverter` bean into both the `RabbitTemplate` and the listener
container).

### notification-service (rewritten)

`q.notifications.all-events` binds to `#` — the one queue in the whole
system bound to *everything*. Every event that arrives is pushed onto
a capped Redis list (`recordRecentEvent`, LPUSH+LTRIM at 200) and
broadcast verbatim to every connected WebSocket client as
`{ type: "event", event: <envelope> }`. `GET /events/recent` (proxied
through the gateway at `/api/v1/notifications/events/recent`) serves
that Redis history so the dashboard has something to show the instant
it loads, before its WebSocket has received anything live.

### gateway (small addition)

Added a `notifications` REST proxy target
(`/api/v1/notifications/* → notification-service`) for the
`/events/recent` bootstrap endpoint. The `/ws/live` WebSocket proxy to
notification-service, `/api/v1/disasters/*` routing, and the
`disasters` write-role rule (`EMERGENCY_OPERATOR`, `SYSTEM_ADMIN`) were
**already fully wired from earlier phases** — confirmed by inspection,
not re-built.

---

## The live emergency dashboard

`frontend/src/pages/EmergencyDashboard.jsx`, reached via the new
**Emergency** nav link:

- **Live Event Feed** (right column) — every event on the bus,
  newest-first, labeled and color-coded by routing key, connects via
  `lib/socket.js`'s auto-reconnecting WebSocket client to `/ws/live`.
  Bootstraps from `GET /events/recent` so it isn't empty on first load.
- **Active Disasters** (left column) — `GET /disasters/active`,
  refreshed automatically whenever a disaster-related event arrives
  over the live feed (no polling loop needed for that).
- **Report a Disaster** — a form (visible only to `EMERGENCY_OPERATOR`/
  `SYSTEM_ADMIN`, same role check the gateway enforces) that calls
  `POST /disasters` — this is literally what makes `DISASTER_DETECTED`
  publish.
- **Situation Report panel** — selecting a disaster polls
  `GET /disasters/:id/situation-report` every 4 seconds, showing each
  of the four services' reaction as it arrives ("awaiting response" →
  real data), plus buttons to mark the disaster Contained/Resolved.

---

## Verifying the event flow actually works

This was the hard requirement: **"Do not proceed until the entire
event flow works."** Two levels of verification were done, in order of
strength:

### 1. A real, live, end-to-end RabbitMQ integration test

Docker isn't available in the environment these files were built in,
but `apt-get install rabbitmq-server redis-server` is (both packages
are on the allowed package mirror) — so rather than trusting a
read-through of the code, **a real RabbitMQ broker was started and the
actual source files were run against it.**

The test harness (not part of the deliverable — it lived outside the
repo and was discarded) imported the **unmodified** `broker.js`,
`consumers/disasterConsumer.js` (hospital and ambulance), and
`consumers/reactionConsumer.js` / `services/situationReportService.js`
(disaster-service) straight out of the built services, connected six
simulated services to the live broker, and:

1. Published `disaster.detected` exactly as `disasterService.js`'s
   `createDisaster()` does.
2. Confirmed hospital-service's and ambulance-service's **real**
   consumer code reacted (using stub `hospitalService`/`ambulanceService`
   objects standing in for the database-backed versions, since this
   harness had no Postgres — the database-backed logic itself is
   already covered by those services' own test suites from earlier
   phases).
3. Simulated the Blood Bank and Power reactions (Java, can't run
   without Maven+JDK+Postgres in this environment) with minimal
   publishers producing the identical envelope shape `EventPublisher.java`
   produces — proving the wire format is language-agnostic, which it
   is by construction (JSON over AMQP).
4. Confirmed disaster-service's **real** `reactionConsumer.js` recorded
   all 4 reactions, each carrying the correct `correlationId`.
5. Confirmed `buildSituationReport()` (the **real**, unmodified
   function) correctly assembled all 4 into a `fullyReported: true`
   report.
6. Confirmed notification-service's wildcard queue received all 5
   events (1 detected + 4 reactions), each with the right correlationId.
7. Repeated the whole thing for `disaster.updated` to confirm the
   update path triggers the identical fan-out.

**Result: 18/18 checks passed**, including a re-run after a severity
escalation. Sample output:

```
=== VERIFICATION ===

  ✓ reaction-aggregator recorded exactly 4 reactions
  ✓ every reaction carries the disaster's id as correlationId
  ✓ aggregator received a reaction under routing key 'hospital.capacity.updated'
  ✓ aggregator received a reaction under routing key 'ambulance.status.updated'
  ✓ aggregator received a reaction under routing key 'blood.shortage.detected'
  ✓ aggregator received a reaction under routing key 'power.infrastructure.at_risk'
  ✓ hospital.capacity.updated payload reflects the stubbed findHospitalsNear result (2 hospitals)
  ✓ hospital.capacity.updated aggregates available bed counts correctly (40+12=52)
  ✓ ambulance.status.updated payload reflects the stubbed findNearestAvailable result (3 ambulances)
  ✓ situationReportService.buildSituationReport() reports fullyReported=true
  ✓ situation report's hospital section has real data (not 'awaiting response')
  ✓ situation report's ambulance section has real data
  ✓ situation report's bloodBank section has real data
  ✓ situation report's power section has real data
  ✓ notification-service's wildcard queue received all 5 events (1 detected + 4 reactions)
  ✓ every event notification-service received carries the disaster's correlationId

[test] publishing DISASTER_UPDATED for the same disaster (severity escalation)...
  ✓ disaster.updated also triggers a fresh 4-way reaction fan-out

=== RESULT: 18 passed, 0 failed ===
```

This is materially stronger evidence than the "please run `mvn test`
and tell me what happens" caveat earlier Java-only phases needed,
because the actual AMQP wiring — exchange declarations, queue
bindings, routing-key matching, JSON envelope (de)serialization,
correlationId propagation — was exercised against a **real broker**,
not asserted by inspection.

### 2. Full test suites, actually run

- `npm install` + `node --test` run for real in every Node service:
  - **disaster-service: 19/19 passing** (schemas, geo math,
    situation-report aggregation logic)
  - **hospital-service: 41/41 passing** (unchanged suite, confirms the
    new consumer wiring didn't break anything existing)
  - **ambulance-service: 36/36 passing** (same)
- `npm run build` (Vite) for the **entire frontend** — all 7 phases'
  worth of pages, including the new `EmergencyDashboard.jsx` and
  `lib/socket.js` — completed with **zero errors**.
- `node --check` syntax-verified every `.js` file touched or added
  across every Node service.

### 3. Java: reviewed and unit-tested, not compiler-verified

Maven still isn't available in this environment (same limitation
documented in Phases 5 and 6). Both Java listeners got dedicated
Mockito-based unit tests
(`blood-bank-service/.../event/DisasterEventListenerTest.java`,
`power-service/.../event/DisasterEventListenerTest.java`) that call
`onDisasterEvent()` directly — no Spring context, no real broker,
same "pure function, mocked collaborators" approach as every other
service-layer test in this project. **Writing these tests caught a
real bug during development:** an early draft's reaction-payload
`Map.of(...)` calls had 6 key/value pairs in three places, exceeding
`Map.of`'s 5-pair overload limit — a compile error that would only
have surfaced when someone finally ran `mvn test`. Fixed with
`Map.ofEntries(...)`. Please still run:

```bash
cd services/blood-bank-service && mvn test
cd services/power-service && mvn test
```

and let me know what comes back — I'd expect a clean pass given the
level of manual + unit-test scrutiny, but this is the one part of
Phase 7 not verified against a real compiler in this environment.

---

## Files created

```
services/disaster-service/
├── package.json, .env.example, Dockerfile (fixed: was missing COPY migrations)
├── migrations/0001_create_disasters.sql, 0002_create_disaster_reactions.sql
└── src/
    ├── index.js, db.js, db/migrate.js
    ├── events/eventTypes.js
    ├── broker.js (rewritten — see "shared broker.js" below)
    ├── middleware/auth.js, validate.js
    ├── schemas/disasterSchemas.js
    ├── repositories/disasterRepository.js, reactionRepository.js
    ├── services/geo.js, disasterService.js, situationReportService.js
    ├── consumers/reactionConsumer.js
    └── routes/disasterRoutes.js
services/disaster-service/tests/schemas.test.js, geo.test.js, situationReport.test.js

services/hospital-service/src/consumers/disasterConsumer.js
services/hospital-service/src/events/eventTypes.js
services/ambulance-service/src/consumers/disasterConsumer.js
services/ambulance-service/src/events/eventTypes.js

services/blood-bank-service/src/main/java/com/sentinelcloud/bloodbank/
├── config/RabbitConfig.java
└── event/EventRoutingKeys.java, EventQueues.java, EventEnvelope.java,
         OutgoingEvent.java, EventPublisher.java, DisasterEventListener.java
services/blood-bank-service/src/test/java/.../event/DisasterEventListenerTest.java

services/power-service/src/main/java/com/sentinelcloud/power/
├── config/RabbitConfig.java
└── event/EventRoutingKeys.java, EventQueues.java, EventEnvelope.java,
         OutgoingEvent.java, EventPublisher.java, DisasterEventListener.java
services/power-service/src/test/java/.../event/DisasterEventListenerTest.java

frontend/src/pages/EmergencyDashboard.jsx
frontend/src/lib/socket.js

docs/PHASE-7-DISASTER.md (this file)
```

## Files modified

- **`services/hospital-service/src/broker.js`**, **`ambulance-service/src/broker.js`**,
  **`notification-service/src/broker.js`** — rewritten with a shared
  shape: `publishEvent` now carries `correlationId`; new
  `assertQueueAndBind`/`consumeQueue` for consuming. (disaster-service's
  copy is new, not a rewrite.)
- **`services/hospital-service/src/index.js`**, **`ambulance-service/src/index.js`**
  — wire up the new `disasterConsumer.js` after the broker connects.
- **`services/notification-service/src/index.js`** — rewritten: wildcard
  queue consumption, WebSocket broadcast, `GET /events/recent`.
- **`services/notification-service/src/redis.js`** — added
  `recordRecentEvent`/`getRecentEvents` (capped list).
- **`services/gateway/src/index.js`**, **`.env.example`** — added the
  `notifications` REST proxy target.
- **`docker-compose.yml`** — added `NOTIFICATION_SERVICE_URL` alongside
  the pre-existing `NOTIFICATION_SERVICE_WS_URL` for the gateway.
- **`frontend/src/lib/api.js`** — added disaster CRUD/situation-report
  functions, `getLiveFeedUrl()`, `fetchRecentEvents()`.
- **`frontend/src/App.jsx`** — added the `/emergency` nav link and route.
- **`docs/ROADMAP.md`** — Phase 7 marked done; Phases 8/9 (originally
  "Notification/Realtime Gateway" and "live map wiring") marked
  superseded, since this phase's scope absorbed both — renumbered
  remaining phases accordingly.

**Not modified:** auth-service (no schema, role, or auth changes
needed — `EMERGENCY_OPERATOR` already existed from the original role
table). `blood-bank-service/pom.xml` and `power-service/pom.xml`
already had `spring-boot-starter-amqp` from earlier phases, so neither
needed a dependency change this phase.

---

## Exact commands to run

```bash
cd sentinelcloud
docker compose up --build
```

disaster-service now: waits for Postgres, runs both migrations,
connects to RabbitMQ (blocking startup completion on this — unlike
other services, a disaster service that can't publish events has
failed at its one job), asserts the reaction-aggregator queue, and
starts listening on port 8086. hospital-service, ambulance-service,
blood-bank-service, and power-service each additionally assert their
own `q.*.disaster-events` queue and start consuming. notification-service
asserts the wildcard queue and starts fanning out.

### Running the tests

```bash
cd services/disaster-service && npm test        # 19/19, verified
cd services/hospital-service && npm test         # 41/41, verified (unchanged suite)
cd services/ambulance-service && npm test        # 36/36, verified (unchanged suite)
cd services/blood-bank-service && mvn test       # not verified in this environment — please run
cd services/power-service && mvn test            # not verified in this environment — please run
```

---

## Demonstration

```bash
# Log in as the seeded SYSTEM_ADMIN (password: DEFAULT_ADMIN_PASSWORD in .env).
# Self-registration only creates CITIZENs since Phase 12; an admin grants
# EMERGENCY_OPERATOR on the Users page.
ADMIN_PW=$(grep '^DEFAULT_ADMIN_PASSWORD=' .env | cut -d= -f2-)
OPERATOR_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@sentinelcloud.local\",\"password\":\"$ADMIN_PW\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['accessToken'])")

# Publish DISASTER_DETECTED
curl -s -X POST http://localhost:8080/api/v1/disasters \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"FLOOD","severity":"HIGH","latitude":18.52,"longitude":73.85,"radiusKm":15,"description":"Heavy monsoon flooding along the riverbank."}' \
  | tee disaster.json
DISASTER_ID=$(python3 -c "import json;print(json.load(open('disaster.json'))['disaster']['id'])")

# Give the four reactions a couple of seconds to fan out, then check the situation report
sleep 3
curl -s http://localhost:8080/api/v1/disasters/$DISASTER_ID/situation-report \
  -H "Authorization: Bearer $OPERATOR_TOKEN" | python3 -m json.tool
```

### In the browser

1. Log in as an `EMERGENCY_OPERATOR` or `SYSTEM_ADMIN`, click **Emergency**
   in the nav.
2. Watch the **Live Event Feed** — within a couple of seconds of
   submitting the form below, you'll see `disaster.detected` followed
   by all four reaction events arrive, each tagged with the same
   correlation id.
3. Use **Report a Disaster** to publish a new one — this is a real
   `POST /disasters` call, not a simulation.
4. Click the disaster in **Active Disasters** to open its situation
   report — each of the four sections fills in live as its reaction
   arrives (open two browser tabs to see it update in one while
   creating the disaster in the other).
5. Mark it **Contained** to see `disaster.updated` flow through the same
   pipeline (the four services react again); **Resolved** is final and is
   announced once as `disaster.resolved` (live feed only, no new reactions).

---

## Known limitations

- **Java listeners not compiler-verified** — see "Verifying the event
  flow actually works" above.
- **No dead-letter exchange** — a handler that throws drops the
  message rather than requeuing it (logged loudly). This is a
  deliberate demo-scope choice (documented in `broker.js`): an infinite
  requeue loop on a permanently-broken handler is a worse failure mode
  than a dropped message for a teaching project. A production system
  would add a DLX per queue.
- **Reaction radius is fixed per-disaster** (`radiusKm` on the
  disaster itself) — each reacting service searches that same radius
  around the same point. A more sophisticated version might let each
  domain use a different radius (e.g. ambulances searching wider than
  blood banks), which isn't implemented here.
- **No automatic ambulance dispatch on disaster detection** — by
  design (see "ambulance-service" above); the reaction reports
  availability, a human still decides on dispatch.
- **The live dashboard's map is still schematic** (inherited from
  Phase 6's `PowerDashboard`, not extended to `EmergencyDashboard` this
  phase) — Active Disasters and the situation report are list/card
  based, not plotted geographically yet. Real map integration is
  explicitly the next roadmap phase.
- **Situation report polling, not event-pushed** — the situation
  report panel polls every 4 seconds rather than updating from the
  same WebSocket the event feed uses. This was a scope/time trade-off;
  the live feed already shows the underlying events arriving in real
  time, and the panel catches up within 4 seconds.
