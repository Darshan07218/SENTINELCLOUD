# Phase 14 — Reliable events

> **Status: implemented.** Sections 1–5 are the design as approved; §6 lists
> where the build differs from it, §7–§8 are the runbooks the two new alerts
> link to, and §9 is how to verify it. Owner in the team plan: Member C.

Phase 15's response engine will *act* on events (dispatch ambulances, reserve
blood). Today an event can be lost in four ways, so this phase closes them
first.

## 1. What can go wrong today

| # | Where | What happens | Evidence |
|---|---|---|---|
| 1 | A service saves a change, then publishes its event | If RabbitMQ is down or the process dies between the two, the change is saved and the event is never sent. Disasters report `eventPublished: false`; ambulance dispatch and hospital alerts only log a warning. | `disasterService.js` `publish()`, `dispatchService.js` `publishBestEffort()`, `hospitalService.js` |
| 2 | Publishing while "connected" | `channel.publish()` doesn't wait for RabbitMQ to confirm it stored the message. A message can vanish if the broker restarts at that moment. | every Node `broker.js` (plain channel, no confirms) |
| 3 | A consumer's handler throws | The message is nacked without requeue and **dropped**. One transient database error loses a disaster reaction for good. | `consumeQueue()` in every Node `broker.js`; `default-requeue-rejected: false` in both Spring services |
| 4 | Nobody can see what was lost | Dropped messages exist only as a log line. | — |

## 2. Design

### 2.1 Transactional outbox (fixes 1)

For the three places that **save and then publish** — disaster create/update/status,
ambulance dispatch/complete/cancel, hospital capacity alerts — the event is
written to an `outbox` table **in the same database transaction** as the
change. Either both are saved or neither is.

```sql
-- one per service database (disaster_db, ambulance_db, hospital_db)
CREATE TABLE outbox (
    id            BIGSERIAL PRIMARY KEY,
    event_id      UUID        NOT NULL UNIQUE,   -- becomes the envelope's eventId / AMQP messageId
    routing_key   TEXT        NOT NULL,
    envelope      JSONB       NOT NULL,          -- the full canonical envelope, built at write time
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ,
    attempts      INT         NOT NULL DEFAULT 0,
    last_error    TEXT
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

A **relay** in each of those services sends outbox rows to RabbitMQ:

- right after a commit (so the normal delay stays in milliseconds), and
- every 2 seconds as a sweep, to pick up anything missed while RabbitMQ was down.

It claims rows with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 50`, so with 3
replicas (the autoscalers allow it) no row is sent by two pods at once. Rows
are marked `published_at` only after RabbitMQ confirms them (2.2). Published
rows older than 7 days are deleted by the same sweep.

`eventPublished` in the disaster API keeps its name and now means "the event
is safely queued". It's `true` whenever the request succeeds, because the
outbox row commits with the disaster. The `verify-system.sh` check that reads
it keeps working.

**Not outboxed:** the four *reaction* events (`hospital.*`, `ambulance.*`,
`blood.*`, `power.*` published in response to a disaster) don't save anything
first. For those, if publishing fails, the handler throws, so the incoming
disaster event is retried (2.3). That gives the same guarantee without a table.

### 2.2 Publisher confirms (fixes 2)

Node services switch to amqplib's `createConfirmChannel()` and `await` each
publish's confirmation. Spring services enable
`spring.rabbitmq.publisher-confirm-type: correlated` and wait for the
confirm in `EventPublisher.publish()`, throwing if it's negative or times out
(5 s).

### 2.3 Retries, then a dead-letter queue (fixes 3 and 4)

When a handler throws:

1. **Retry in place**, up to 3 attempts with 1 s → 2 s → 4 s back-off
   (Node: a loop in `consumeQueue()`; Spring: `spring.rabbitmq.listener.simple.retry`).
2. Still failing → nack without requeue. RabbitMQ moves the message to the
   **dead-letter exchange** `sentinelcloud.dlx`, which routes it to one queue,
   `q.dead-letters`. The original routing key is kept, and RabbitMQ's `x-death`
   header records which queue it came from and why.

Malformed messages skip the retries and go straight to the dead-letter queue.

**How the queues get a dead-letter exchange.** Queue arguments can't be
changed on an existing durable queue (redeclaring with new arguments fails
with `PRECONDITION_FAILED`), and every existing install already has these
queues. So instead of queue arguments, a RabbitMQ **policy** applies it to the
six durable queues: `q.{hospital,ambulance,bloodbank,power}.disaster-events`,
`q.disaster.reaction-aggregator`, `q.notifications.all-events`. A policy can be
added to existing queues at any time, and needs no code change in the Spring
services. The per-pod `q.notifications.live.*` queues are excluded, since a lost
live-feed push is harmless and the event is still in Redis history.

- Kubernetes: a `postStart` hook on the RabbitMQ StatefulSet waits for the
  broker, then runs `rabbitmqctl set_policy` (idempotent, reapplied on every start).
- Docker Compose: a one-shot `rabbitmq-setup` service does the same after
  RabbitMQ is healthy.
- `sentinelcloud.dlx` and `q.dead-letters` are declared by every service on
  connect (idempotent), like the main exchange today, so the policy never
  points at a missing exchange.

### 2.4 Duplicates are safe

Outbox, confirms and retries give *at-least-once* delivery: a message can now
arrive twice (for example, the relay crashes after RabbitMQ confirmed but
before `published_at` was saved). Consumers already handle that, or are made to:

| Consumer | Today | Change |
|---|---|---|
| disaster reaction aggregator | `ON CONFLICT (disaster_id, event_type, source_service)` | none |
| hospital / ambulance / blood / power reactions | re-run a read-only radius search and republish | none; a duplicate reaction is absorbed by the aggregator |
| notification live feed | would show the event twice | skip an `eventId` already in the Redis history |

### 2.5 Seeing it

- **Metrics:** `sentinel_outbox_pending` (gauge) and
  `sentinel_outbox_publish_failures_total` in the three outbox services;
  `sentinel_events_consumed_total{outcome="dead_lettered"}` alongside the existing outcomes.
- **Alerts:** `SentinelOutboxBacklog` (pending > 0 for 2 min) and
  `SentinelDeadLetters` (`q.dead-letters` not empty), each with promtool unit tests.
- **Grafana:** an "Event reliability" row on System Health: outbox backlog,
  dead-letter count, retries per minute.
- **Admin API (gateway, SYSTEM_ADMIN):** `GET /api/v1/notifications/dead-letters`
  lists the dead-letter queue without removing anything;
  `POST …/dead-letters/replay` sends them back to their original routing key
  once the cause is fixed.

## 3. Files

| Area | Change |
|---|---|
| `services/{disaster,ambulance,hospital}-service/migrations` | new `000N_create_outbox.sql` |
| `services/*/src/broker.js` (6 Node services that use RabbitMQ) | confirm channel; `consumeQueue()` retries + dead-letter; assert DLX + `q.dead-letters` |
| `services/{disaster,ambulance,hospital}-service/src/outbox.js` | new: `enqueue(client, routingKey, payload, correlationId)`, relay loop, metrics |
| `disasterService.js`, `dispatchService.js`, `hospitalService.js` | write to the outbox inside the existing transaction instead of publishing |
| `services/{blood-bank,power}-service` | `application.yml` confirms + retry; `EventPublisher` waits for the confirm; `RabbitConfig` declares DLX + `q.dead-letters` |
| `services/notification-service` | eventId de-duplication; dead-letter list/replay endpoints |
| `services/gateway/src/routeAccessRules.js` | dead-letter routes, SYSTEM_ADMIN only |
| `k8s/base/infrastructure/rabbitmq.yaml`, `docker-compose.yml` | the policy (postStart hook / `rabbitmq-setup`) |
| `k8s/base/monitoring/config/prometheus/rules`, `…/tests`, Grafana dashboard | the 2 alerts + tests, the new row |
| `docs/EVENT-SCHEMA.md`, `docs/SYSTEM-REFERENCE.md` §14 | delivery guarantees; remove the "no outbox / no DLQ" limitation |

## 4. Tests

- **Unit:** outbox enqueue/relay ordering and claim logic; `consumeQueue()`
  retry count, back-off and dead-lettering; notification de-duplication;
  `EventPublisher` throws on a negative confirm.
- **Real PostgreSQL (`tests/db`):** the outbox row commits and rolls back with
  its disaster / dispatch; two relays never claim the same row.
- **System (new `verify-system.sh` checks):**
  1. Stop RabbitMQ, report a disaster → API succeeds, `sentinel_outbox_pending` = 1.
     Start RabbitMQ → the event goes out and the situation report reaches 4/4.
  2. Publish a malformed event → it appears in `q.dead-letters` and the alert fires.
- The existing Resilience Demo **message-broker drill** gains a stronger claim:
  disasters reported *during* the outage are delivered after it.

## 5. Risks and choices

- **Small extra latency** (one confirm round trip, a few ms) on each publish. Fine at this scale.
- **Relay polling** costs one indexed query every 2 s per pod. Postgres `LISTEN/NOTIFY`
  could replace it later; polling is simpler and survives restarts.
- **Retry blocks the queue briefly.** In-place retries hold one of the 10 prefetched
  messages for up to 7 s. Delayed-retry queues would avoid that, but they add
  three more queues per consumer; not worth it for a demo-scale system.
- **Order:** events from one service stay in order (the relay sends by `id`).
  There is no global order across services, same as today.

## 6. As built: differences from the design

- **One shared broker and outbox.** The four Node services that use RabbitMQ
  now ship identical copies of `shared/node-broker/broker.js` (and three of
  them `outbox.js`), synced by `scripts/sync-shared-broker.ps1` / `.sh`;
  `shared/node-broker/tests/copies.test.js` fails if a copy drifts. Same
  approach as the Phase 12 security modules. The gateway only checks that
  RabbitMQ is reachable, so it keeps its own small `broker.js`.
- **Outcome labels unchanged.** Instead of a new `dead_lettered` outcome,
  `sentinel_events_consumed_total{outcome="error"}` now means "dead-lettered
  after every retry failed", and `outcome="invalid"` "not an event,
  dead-lettered at once". The existing `SentinelEventHandlerErrors` alert
  already fires on any non-success outcome. `outcome="success"` includes
  events that needed a retry.
- **The dead-letter list is SYSTEM_ADMIN-only inside notification-service**
  (like auth-service's `/users`); the gateway's role table already limits the
  replay `POST` to SYSTEM_ADMIN.
- **Compose uses a `post_start` hook** on the RabbitMQ service rather than a
  separate one-shot container; it runs the same script as Kubernetes'
  `postStart` hook (`k8s/base/config/rabbitmq-set-policies.sh`).
- **`SentinelQueueWithoutConsumers` ignores `q.dead-letters`**, which has no
  consumer by design.
- **Fixed along the way** (found while getting a trustworthy test baseline):
  - `scripts/run-node-tests.sh` reported cancelled tests as passing, and read
    nothing on Node 23+ (which defaults to the "spec" reporter). It now uses
    the TAP reporter and counts cancelled tests as failures.
    `scripts/run-node-tests.ps1` is a new Windows version.
  - The three pg-mem integration suites (auth, hospital, ambulance) never ran:
    they called `db.public.registerExtension`, which pg-mem 2.9 doesn't have.
    The auth suite also needed a pg-mem-friendly `UPDATE` (no alias on the
    target) in `userRepository.updateGuarded`, identical in PostgreSQL.
  - `tests/db/realPostgres.test.js` couldn't import modules on Windows
    (absolute paths need `file://` URLs).
  - power-service's `DisasterEventListenerTest` failed because its test
    transformers had no id; it now gives them one, as saved ones have.

## 7. Alert: SentinelOutboxBacklog

**Means:** a service has saved changes whose events RabbitMQ hasn't confirmed
for 2 minutes. Nothing is lost; other services just won't react yet.

1. Is RabbitMQ up? `SentinelRabbitMQDown` / `SentinelServiceLostBrokerConnection`
   usually fire alongside. Fix that and the backlog drains by itself within
   a few seconds (watch "Outbox backlog by service" on System Health).
2. If RabbitMQ is fine, look at the rows the relay is stuck on:
   ```sql
   -- psql into the service's database, e.g. disaster_db
   SELECT id, routing_key, attempts, last_error, created_at
     FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 10;
   ```
   `last_error` says why RabbitMQ refused it. The relay stops at the first
   failing row to keep order, so one bad row holds back the ones after it.
3. Check the service's logs for `[outbox] relay pass failed`, which means the
   relay couldn't reach its own database.

## 8. Alert: SentinelDeadLetters

**Means:** events failed every retry (or weren't valid events) and are parked
in `q.dead-letters`.

1. See what they are and where they came from (SYSTEM_ADMIN token):
   ```
   GET /api/v1/notifications/dead-letters?limit=50
   ```
   Each entry has `fromQueue`, `routingKey`, `sourceService`,
   `correlationId`, `reason` and `malformed`.
2. Find the cause in the consuming service's logs: search for
   `failed 4 times on event` (Node) or the listener's stack trace (Spring).
3. Once it's fixed, send them back to their original routing key:
   ```
   POST /api/v1/notifications/dead-letters/replay   {"limit": 50}
   ```
   A message that fails again just returns to the dead-letter queue, so
   replaying is always safe. Malformed messages can't be replayed; read them
   in the RabbitMQ management UI, then purge them there.

## 9. How to verify

| What | Command | Result when this was built |
|---|---|---|
| Node unit + pg-mem integration tests | `.\scripts\run-node-tests.ps1` (or `.sh`) | 408 passed, 0 failed (370 before Phase 14) |
| Java tests | `mvn test` in each Spring service (or the Maven container, see below) | blood-bank 43, power 35, all passed |
| Alert unit tests | `promtool test rules k8s/base/monitoring/config/prometheus/tests/alerts.test.yml` | SUCCESS (3 new tests) |
| Real PostgreSQL suite | see the header of `tests/db/realPostgres.test.js` | 35 passed, incl. 4 outbox tests: commit/rollback with the change, waiting through an outage, two concurrent relays never send the same row |
| End to end on Kubernetes | §9.1 and §9.2 below | both passed on Docker Desktop Kubernetes, 2026-10-24 |

Without Maven installed:
`docker run --rm -v "<service dir>:/app" -v sentinel-m2:/root/.m2 -w /app maven:3.9-eclipse-temurin-21 mvn -B test`

### 9.1 End to end: a disaster survives a RabbitMQ outage

1. Stop RabbitMQ: `kubectl scale statefulset rabbitmq -n sentinelcloud --replicas=0`
   (Compose: `docker compose stop rabbitmq`).
2. Report a disaster on the Emergency page. It's saved; `eventPublished` is
   `true`; `sentinel_outbox_pending{job="disaster-service"}` is 1.
3. Start RabbitMQ again (`--replicas=1` / `docker compose start rabbitmq`).
4. Within seconds of the services reconnecting, `disaster.detected` goes out,
   all four services react, and the situation report reaches 4/4. The
   outbox count returns to 0.

Observed (upgrade of a running install, 2026-10-24): with RabbitMQ at 0
replicas the disaster was created with `eventPublished: true` and its outbox
row showed `attempts 3, last_error "RabbitMQ is not connected"`. RabbitMQ was
ready again after 45 s; the outbox was empty 63 s after the restart began, and
the situation report showed `respondedServices: 4 / 4, fullyReported: true`.
Before Phase 14 this disaster would never have reached the other services.

### 9.2 A bad message is parked, not dropped

Publish something that isn't an event on `disaster.detected` (RabbitMQ
management UI → Exchanges → `sentinelcloud.events` → Publish message, payload
`not an event {`). It reaches five durable queues; each consumer rejects it
and the policy moves it to `q.dead-letters`.

Observed: 5 dead letters (hospital, ambulance, blood-bank, power and
notification history queues), all listed by `GET /api/v1/notifications/dead-letters`
with `reason: rejected, malformed: true`; a CITIZEN gets 403 on the list and
the replay; `SentinelDeadLetters` went pending and `SentinelQueueWithoutConsumers`
stayed quiet. The RabbitMQ log shows `Successfully set policy
'sentinel-dead-letter'` on every broker start.
