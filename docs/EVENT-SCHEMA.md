# SentinelCloud event schema

Every asynchronous message in SentinelCloud goes through **one RabbitMQ
topic exchange, `sentinelcloud.events`** (durable). Publishers choose a
routing key; consumers bind durable queues to the keys they care about.
No service calls another service synchronously to react to a disaster.

This file is the contract. The routing keys are mirrored in each
service's `src/events/eventTypes.js` (Node) or `event/EventRoutingKeys.java`
(Spring) and in the frontend's `src/lib/events.js`.

## Envelope

Every message body is UTF-8 JSON with this envelope
(`contentType: application/json`, `persistent: true`,
`messageId = eventId`):

| Field | Type | Meaning |
|---|---|---|
| `eventId` | UUID string | Unique per message; the consumer-side idempotency key |
| `eventType` | string | Same as the routing key |
| `occurredAt` | ISO-8601 UTC, millisecond precision | When the publisher created the event (Java publishers truncate to ms like Node) |
| `sourceService` | string | `disaster-service`, `hospital-service`, `ambulance-service`, `blood-bank-service`, `power-service` |
| `correlationId` | UUID string or `null` | For disaster reactions: the disaster's id. Ties a whole reaction chain together |
| `payload` | object | Event-specific, below |

Consumers treat bus messages as untrusted input: a body that isn't a JSON
object is dropped (counted as `outcome="invalid"`), disaster payloads with
missing/out-of-range coordinates or a radius above 500 km are dropped, and
reactions are stored only for a known event type from a known service with
a UUID correlation id. A handler that throws is retried in place (1 s, 2 s,
4 s); if it still fails, the message is *nacked without requeue* (no
poison-message loop) and, since Phase 14, moved to `q.dead-letters` instead
of being dropped. A body that isn't an event goes there straight away.
Payloads that parse but fail validation are acknowledged and logged, not
dead-lettered. Metrics are labelled by the **delivered routing key**, not by
the body's `eventType`.

## Routing keys

| Routing key | Publisher | Consumed by (queue) | Trigger |
|---|---|---|---|
| `disaster.detected` | disaster-service | hospital, ambulance, blood-bank, power (`q.<svc>.disaster-events`); notification (`#`) | `POST /disasters` |
| `disaster.updated` | disaster-service | same as above | `PUT /disasters/{id}`, status → ACTIVE or CONTAINED |
| `disaster.resolved` | disaster-service | notification (`#`) only | status → RESOLVED (final). Deliberately **not** bound by the four reacting services: a closed disaster needs no new reactions |
| `hospital.capacity.updated` | hospital-service | disaster (`q.disaster.reaction-aggregator`); notification | reaction to `disaster.detected/updated` |
| `ambulance.status.updated` | ambulance-service | aggregator; notification | reaction |
| `blood.shortage.detected` | blood-bank-service | aggregator; notification | reaction |
| `power.infrastructure.at_risk` | power-service | aggregator; notification | reaction (a transformer counts as at risk from WARNING upwards) |
| `hospital.capacity.alert` | hospital-service | notification only | a capacity change leaves a hospital with active alerts |
| `ambulance.dispatched` | ambulance-service | notification only | an ambulance is assigned to an emergency |
| `emergency.unassigned` | ambulance-service | notification only | a new emergency found no available ambulance |
| `emergency.resolved` | ambulance-service | notification only | `POST /emergencies/{id}/complete` |
| `command.ambulance.dispatch` · `command.ambulance.stand-down` | response-service | ambulance (`q.ambulance.commands`); notification | Phase 15: an approved plan dispatches ambulances / its undo cancels those calls |
| `command.blood.reserve` · `command.blood.release` | response-service | blood-bank (`q.bloodbank.commands`); notification | Phase 15: reserve blood for the receiving hospital / undo |
| `command.disaster.widen-radius` | response-service | disaster (`q.disaster.commands`); notification | Phase 15: escalation, too few ambulances in range |
| `command.succeeded` · `command.failed` | ambulance, blood-bank, disaster | response (`q.response.events`); notification | Phase 15: the executor's reply, `correlationId` = command id |
| `response.plan.proposed` · `approved` · `rejected` · `completed` · `expired` · `rolled_back` | response-service | notification only | Phase 15: a plan's lifecycle (the Emergency page refreshes on these) |

### Queues

| Queue | Bound to | Notes |
|---|---|---|
| `q.hospital.disaster-events` | `disaster.detected`, `disaster.updated` | competing consumers across replicas |
| `q.ambulance.disaster-events` | same | |
| `q.bloodbank.disaster-events` | same | Spring `@RabbitListener`, `default-requeue-rejected: false` |
| `q.power.disaster-events` | same | |
| `q.disaster.reaction-aggregator` | the four reaction keys | fan-in for situation reports |
| `q.notifications.all-events` | `#` | writes each event once to Redis `sentinelcloud:events:recent` (capped list, 200) |
| `q.notifications.live.<pod>` | `#` | exclusive, auto-delete, one per notification-service replica → WebSocket broadcast. Not dead-lettered: a lost push is harmless, the event is still in Redis history |
| `q.response.events` | `disaster.*`, the four reaction keys, `command.succeeded/failed` | Phase 15: response-service's single queue |
| `q.ambulance.commands` · `q.bloodbank.commands` · `q.disaster.commands` | their `command.*` keys | Phase 15: executed once per command id (`processed_commands` table) |
| `q.dead-letters` | `#` on exchange `sentinelcloud.dlx` | Phase 14. Every message the other durable queues reject after retries. No consumer: list it with `GET /api/v1/notifications/dead-letters`, send it back with `POST …/dead-letters/replay` (SYSTEM_ADMIN) |

All the durable queues above except `q.notifications.live.*` and
`q.dead-letters` (ten since Phase 15) get their dead-letter
exchange from the RabbitMQ policy `sentinel-dead-letter`
(`k8s/base/config/rabbitmq-set-policies.sh`, applied on every broker start),
not from queue arguments, which can't be changed on an existing queue.

## Payloads

### `disaster.detected` / `disaster.updated` / `disaster.resolved`

```json
{
  "disasterId": "3f0c…", "type": "FLOOD", "severity": "HIGH",
  "latitude": 18.52, "longitude": 73.85, "radiusKm": 15,
  "description": "Heavy monsoon flooding along the riverbank.",
  "status": "ACTIVE", "statusNote": null, "occurredAt": "2026-10-04T06:00:00.000Z"
}
```

`type` ∈ FLOOD, FIRE, EARTHQUAKE, CYCLONE, LANDSLIDE, INDUSTRIAL_ACCIDENT;
`severity` ∈ LOW, MEDIUM, HIGH, CRITICAL; `status` ∈ ACTIVE, CONTAINED,
RESOLVED; `radiusKm` ∈ (0, 500]; `correlationId` = `disasterId`.

### Reactions (`correlationId` = the disaster's id)

```jsonc
// hospital.capacity.updated
{ "disasterId": "…", "searchRadiusKm": 15, "nearbyHospitalCount": 3,
  "totalAvailableBeds": 120, "totalAvailableIcuBeds": 14, "totalAvailableVentilators": 9,
  "nearbyHospitals": [{ "id": "…", "name": "…", "distanceKm": 2.1, "availableBeds": 40, "availableIcuBeds": 5,
                       "availableVentilators": 3, "emergencyStatus": "NORMAL" }] }

// ambulance.status.updated — count is every AVAILABLE ambulance in range,
// the list is the nearest 20
{ "disasterId": "…", "searchRadiusKm": 15, "availableAmbulanceCount": 7,
  "availableAmbulances": [{ "id": "…", "vehicleNumber": "MH12-AB-1001", "equipmentLevel": "ADVANCED", "distanceKm": 3.4, "etaMinutes": 5.2 }] }

// blood.shortage.detected — shortage alerts AT the nearby banks only
{ "disasterId": "…", "searchRadiusKm": 15, "nearbyBloodBankCount": 2,
  "nearbyBloodBanks": [{ "id": "…", "name": "…", "distanceKm": 4.0 }],
  "shortageAlertCount": 3,
  "shortageAlerts": [{ "severity": "CRITICAL", "type": "LOW_STOCK", "bloodBankName": "…", "bloodType": "O-", "message": "…" }] }

// power.infrastructure.at_risk
{ "disasterId": "…", "searchRadiusKm": 15, "nearbySubstationCount": 2, "totalAtRiskTransformerCount": 1,
  "nearbySubstations": [{ "id": "…", "name": "…", "distanceKm": 1.2, "transformerCount": 3, "atRiskTransformerCount": 1,
                          "transformers": [{ "id": "…", "code": "TXF-01", "status": "WARNING" }] }] }
```

Distances: the radius filter is straight-line (Haversine) km everywhere;
ambulance `distanceKm`/`etaMinutes` are the road-distance estimate (×1.3
detour factor, 55 km/h, 90 s turnout) used for ranking.

### Notification-only events

```jsonc
// hospital.capacity.alert
{ "hospitalId": "…", "hospitalName": "…", "alerts": [{ "severity": "CRITICAL", "type": "NO_ICU_AVAILABLE", "message": "…" }], "capacity": { "...": "…" } }
// ambulance.dispatched
{ "ambulanceId": "…", "vehicleNumber": "…", "emergencyId": "…", "distanceKm": 2.3, "etaMinutes": 4.0 }
// emergency.unassigned
{ "emergencyId": "…", "reason": "no_available_ambulance_in_range" | "all_candidates_taken_concurrently", "searchRadiusKm": 50 }
// emergency.resolved
{ "emergencyId": "…", "ambulanceId": "…" }
```

## Delivery guarantees and ordering

- **At-least-once, end to end (Phase 14).**
  - *Saved change → event:* disaster, ambulance-dispatch and hospital-alert
    events are written to the service's `outbox` table in the same database
    transaction as the change, and a relay sends them (right away, then a
    sweep every 2 s). A change can't be saved without its event, and an event
    saved while RabbitMQ is down is sent when it's back.
  - *Publish → broker:* every publisher waits for RabbitMQ's publisher
    confirm (5 s timeout). Reactions to a disaster aren't outboxed: if their
    publish fails, the handler fails and the disaster event is retried.
  - *Broker → consumer:* messages are persistent and acknowledged after the
    handler succeeds; failures are retried, then dead-lettered (above).
  - *Duplicates are expected and harmless:* the aggregator's upsert is keyed
    by `(disaster_id, event_type, source_service)`; the reacting services
    re-run a read-only search; the notification history and live feed skip
    an `eventId` they've already stored or pushed.
- **Out-of-order safe.** The aggregator stores the publisher's
  `occurredAt` and only replaces a stored reaction with one that is at
  least as new; a late redelivery of an older reaction is ignored
  (`tests/db/realPostgres.test.js` checks this on real Postgres).
- **Writes don't wait for RabbitMQ.** A hospital update or a new disaster
  succeeds while RabbitMQ is down; its event waits in the outbox. For
  disasters, `eventPublished` now means "safely queued for delivery" and is
  `true` whenever the request succeeds.
- **Order:** one service's outbox events are sent in the order they were
  saved. There is no global order across services.
- **Reconnects.** Node services reconnect forever with capped backoff and
  re-declare their queues; a channel that dies on its own now closes the
  connection so it goes through the same reconnect path. Spring AMQP
  reconnects on its own.

## Live feed (WebSocket)

`ws(s)://<host>/ws/live` through the gateway; sub-protocols
`["sentinel-live", "bearer.<accessToken>"]`; origin checked against the
CORS allow-list. Frames: `{type:"welcome"}`, `{type:"heartbeat"}` every
15 s, `{type:"event", event:<envelope>}`. The server pings every 30 s and
drops sockets that don't answer or that fall more than 1 MB behind. The
REST bootstrap is `GET /api/v1/notifications/events/recent?limit=1..200`.
