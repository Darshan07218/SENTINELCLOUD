# Phase 15 — Automated response engine

> **Status: implemented and verified on Kubernetes** (2026-10-24). §1–§7 are
> the design; §8 lists what changed while building it, §9 the evidence.
> Owner in the team plan: Member B (engine), Member A (approval screen).

Until now SentinelCloud *detects and reports*: a disaster arrives, four
services say what they have nearby, and a person does everything else. This
phase adds a ninth microservice, **response-service**, that turns a situation
report into a **response plan** (dispatch these ambulances, reserve this
blood, widen the search) and carries it out once an operator approves it.
Every action is recorded and can be undone.

## 1. How it works

```
disaster.detected ──► 4 reacting services ──► 4 reaction events
        │                                            │
        └──────────────► response-service ◄──────────┘
                          │  playbook(type, severity, reactions)
                          ▼
                   response plan: PROPOSED
                          │  operator clicks Approve (or auto mode)
                          ▼
            command events via the outbox ──► ambulance / blood-bank / disaster
                          ▲                               │
                          └──── command.succeeded/failed ◄┘
```

1. response-service listens to `disaster.*` and the four reaction events and
   keeps its own picture of each disaster (no synchronous calls; it builds its
   view from events, like the situation report does).
2. When the hospital, ambulance and blood-bank reactions for the disaster's
   current radius have arrived (or 20 s after detection, with whatever has
   arrived), it runs the **playbook** for the disaster's type and severity
   and stores a plan of actions.
3. **Approval mode (default):** the plan waits as PROPOSED until an
   EMERGENCY_OPERATOR or SYSTEM_ADMIN approves or rejects it on the Emergency
   page. **Auto mode** (`RESPONSE_AUTO_APPROVE=true`) executes immediately.
4. Approved actions are sent as **command events** through the Phase 14
   outbox, so a command can't be lost. The service that owns the resource
   executes it and replies with `command.succeeded` or `command.failed`.
5. **Undo** sends the reverse command for every action that succeeded
   (cancel the emergencies, which frees the ambulances; release the blood
   reservations).

## 2. Playbook

One readable table (`services/response-service/src/playbook.js`), pure
functions, unit-tested:

| | LOW | MEDIUM | HIGH | CRITICAL |
|---|---|---|---|---|
| Ambulances needed | 1 | 2 | 4 | 6 |
| Blood units (O−, O+ each) | 0 | 2 | 4 | 8 |

Type adjustments: EARTHQUAKE ×1.5 ambulances; CYCLONE and
INDUSTRIAL_ACCIDENT ×1.25; FIRE and INDUSTRIAL_ACCIDENT ×1.5 blood (burns).

Actions it can propose:

| Action | Executed by | Undo |
|---|---|---|
| `ambulance.dispatch` — N emergency calls at the disaster's location, each auto-dispatched to the nearest free ambulance (existing dispatch logic) | ambulance-service | cancel those emergencies → ambulances freed |
| `blood.reserve` — units of one blood type at the nearest blood bank, for the nearest hospital with free beds | blood-bank-service | release the reservation |
| `disaster.widen_radius` — **escalation**: fewer ambulances in range than needed → double the radius (max 50 km), once per disaster | disaster-service | none (recorded) |
| `notice` — advice that needs a human (e.g. "2 transformers at risk: send a line crew", "only 3 ICU beds within 15 km") | — (information only) | — |

Escalation closes the loop: widening the radius republishes
`disaster.updated`, the four services react again at the new radius, and
response-service proposes a **revision 2** plan for the shortfall only (no
second escalation).

## 3. Commands

Routing keys `command.<service>.<action>`, published only by response-service
(consumers reject any other `sourceService`). Payload always has `commandId`
(UUID) and `planId`.

| Routing key | Queue | Payload |
|---|---|---|
| `command.ambulance.dispatch` | `q.ambulance.commands` | `disasterId, latitude, longitude, count, severity, description` |
| `command.ambulance.stand-down` | `q.ambulance.commands` | `emergencyIds[]` |
| `command.blood.reserve` | `q.bloodbank.commands` | `bloodBankId, bloodType, units, hospitalId, requestedBy` |
| `command.blood.release` | `q.bloodbank.commands` | `reservationId` |
| `command.disaster.widen-radius` | `q.disaster.commands` | `disasterId, radiusKm` |
| `command.succeeded` / `command.failed` | `q.response.events` | `commandId, command, result` / `error {code, message}` |

**Exactly-once effect on at-least-once delivery.** Each executor records
`commandId` in a `processed_commands` table in the same transaction as the
effect. A redelivered command doesn't run again; its stored result is sent
again instead. Ambulance dispatch also tags each emergency it creates with the
command id, so a retry after a crash halfway only creates the missing ones.

The new command queues and `q.response.events` join the Phase 14
dead-letter policy.

## 4. response-service

Node, port 8089, database `response_db` (user `response_svc`), same skeleton as
the other Node services (migrations, metrics, security modules, shared broker
and outbox).

Tables: `disaster_context` (latest disaster fields + reactions per disaster),
`response_plans` (one per disaster and revision; status), `response_actions`
(kind, params, status, result, command ids), `outbox`.

Plan status: `PROPOSED → EXECUTING → COMPLETED | PARTIAL`;
`PROPOSED → REJECTED`; `PROPOSED → EXPIRED` (disaster resolved first);
`COMPLETED | PARTIAL → UNDOING → ROLLED_BACK`. Approve, reject and undo are
conditional updates, so two operators can't approve the same plan twice. An
action with no reply within 2 minutes is marked FAILED (timeout).

API (through the gateway at `/api/v1/response`):

| Method | Path | Who |
|---|---|---|
| GET | `/plans?disasterId=&status=&limit=` | any signed-in user |
| GET | `/plans/{id}` | any signed-in user |
| POST | `/plans/{id}/approve` · `/reject` · `/undo` | EMERGENCY_OPERATOR, SYSTEM_ADMIN |
| GET | `/playbook` | any signed-in user (the table above, for the UI) |

It publishes `response.plan.proposed | approved | rejected | completed |
rolled_back` so the live feed and the Emergency page update on their own.

## 5. Infrastructure

- **New database on existing installs.** Postgres runs its init script only on
  an empty data volume. The script is already idempotent, so Postgres now
  runs it on **every start** too (Kubernetes `postStart` hook, Compose
  `post_start`), the same pattern as Phase 14's RabbitMQ policy. Adding
  `response_db` then needs no manual step.
- New secret `RESPONSE_DB_PASSWORD` (generator, `.env.example`,
  `secrets.env.example`), Compose service, Kubernetes Deployment/Service/HPA,
  NetworkPolicy, Prometheus scrape (annotation-based, so automatic), gateway
  route + role rule + health check, image build lists.

## 6. Frontend

The Emergency page gets a **Response plan** card for the selected disaster:
the plan's actions with their status, and Approve / Reject / Undo buttons for
operators. It refreshes on `response.plan.*` and `command.*` events from the
live feed.

## 7. Tests

- Playbook: needs per type/severity, escalation once, revision-2 shortfall,
  target selection (nearest hospital with beds, nearest bank), notices.
- Executors: idempotency (same command twice → one effect, same reply).
- response-service: plan lifecycle (approve/reject/undo, races → 409, expiry,
  timeout), command-result handling, readiness for planning.
- Real PostgreSQL: dispatch command idempotency and partial-retry.
- End to end on Kubernetes: report a HIGH flood → plan proposed → approve →
  ambulances dispatched and blood reserved → undo → ambulances free again.

## 8. As built: notes and changes from the design

- **Shared command processor.** The Node executors (ambulance, disaster)
  share `shared/node-broker/commands.js` (synced like `broker.js`); the Java
  executor is `blood-bank-service/.../event/CommandListener.java`. Both write
  `processed_commands` in the same transaction as the effect. The Java one
  claims the command id *first* in that transaction, because a failed
  reservation marks Spring's transaction rollback-only; the failure is then
  recorded in a transaction of its own.
- **Blood per type, never the same failed bank twice.** The playbook picks a
  bank per blood type: the nearest without a LOW_STOCK alert for that type,
  and in revision 2 never a bank where that type already failed.
- **Revision 2 waits for revision 1 to settle.** Found on the cluster: a
  dispatch of 8 ambulances replied after the escalation, and the follow-up was
  planned in between, counting "0 sent" and asking for 4 more instead of 1.
  The follow-up is now planned only once revision 1 is COMPLETED or PARTIAL
  (never after an undo), and every reply re-checks. Regression test in
  `tests/db/realPostgres.test.js`.
- **New databases on existing installs.** Postgres re-runs its idempotent
  init script on every start (`k8s/base/config/postgres-ensure-databases.sh`,
  Kubernetes `postStart` / Compose `post_start`). Verified twice: on a test
  database with `response_db` dropped, and on the running cluster, where the
  upgrade created `response_db` and response-service started on it.
- **Dead-letter policy** now covers ten durable queues (the four new ones
  added). The log line of both hook scripts no longer prints a shell error
  when the container's log isn't writable.
- **Plan card** (`frontend/src/components/ResponsePlanPanel.jsx`) under the
  situation report; the live feed shows plan and command events with labels.
- Partial results are reported as they are: a dispatch that finds no free
  ambulance leaves the call open (`unassignedCount`), and the plan is PARTIAL
  if any action failed.

## 9. Verification

| What | Result |
|---|---|
| Node tests (`.\scripts\run-node-tests.ps1`) | 458 passed, 0 failed (408 before this phase): playbook 20, engine helpers 13, command processor 6, ambulance commands 6, plus the existing suites |
| Java tests | blood-bank 47 (4 new: `CommandListenerTest`), power 35 |
| Real PostgreSQL suite | 44 passed: response-service migrations; plan proposed once; approve → commands, second approve 409; replies → PARTIAL; escalation → revision 2 for the shortfall only; undo → stand-down + release → ROLLED_BACK; resolve expires an undecided plan; reject sends nothing; timeout → FAILED; planning after the wait without all reactions; follow-up waits for a slow dispatch; a duplicated dispatch command creates its calls once |
| Kubernetes upgrade | all 15 deployments rolled out; `response_db` created by the Postgres hook; the four new queues each have a consumer; dead-letter policy includes them |

### 9.1 End to end on the cluster (2026-10-24)

1. **HIGH flood in Pune** → plan proposed **2 s** later from live data:
   dispatch 4 (8 free within 15 km); reserve 4 O− and 4 O+ at Pune Regional
   Blood Bank for Sassoon General Hospital, with a warning that the bank is low
   on O−; a notice about 1 transformer at risk.
2. **Approve** → settled 2 s later as **PARTIAL**: 4 ambulances dispatched
   (each an emergency call assigned to a real ambulance), O+ reserved, O−
   failed with `INSUFFICIENT_INVENTORY` (the bank had 0). A second approve: 409.
3. Checked in the other services: the 4 ambulances DISPATCHED, the reservation
   active.
4. **Undo** → ROLLED_BACK 2 s later: all 4 ambulances AVAILABLE again, the
   reservation released.
5. **CRITICAL earthquake** (needs 9, 8 in range) → dispatch 8 + widen to
   30 km; after approval the radius became 30 km, the services re-reported,
   and revision 2 proposed exactly **1** more ambulance ("8 already sent") and
   O− from a **different** bank. Executed, then both plans undone: all
   ambulances AVAILABLE. Test disasters resolved afterwards.

### 9.2 Demo script

On the Emergency page: report a HIGH flood → the Response Plan card fills in
within seconds → read the reasons aloud → **Approve and execute** → watch the
actions turn green (and one honest failure) → open Ambulances to show the
dispatched units → **Undo plan** → ambulances free again. For escalation, use a
CRITICAL earthquake.