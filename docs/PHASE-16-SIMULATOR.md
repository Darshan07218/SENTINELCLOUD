# Phase 16 — Scenario simulator

> **Status: implemented and verified on Kubernetes** (2026-10-24). §1–§6 are
> the design; §7 lists what changed while building it, §8 the evidence.
> Owner in the team plan: Member D.

A live demo needs someone to click through a disaster while also explaining
it. This phase adds **simulator-service**, which plays a disaster out over
a few minutes on its own (the "hands-free demo"). It can also keep the city
**alive** in the background: ambulances drive their calls to the end, and
transformers and hospitals report changing numbers.

## 1. Design decision: a real client, not a back door

The simulator changes data only **through the API gateway, like a person
would**, with its own account. So every step passes the same
authentication, role checks, rate limits and audit log as a user's click,
and every event flows exactly as in real use. It never touches a database or
the message bus directly.

- **Account:** auth-service seeds a dedicated SYSTEM_ADMIN service account,
  `SIMULATOR_EMAIL` / `SIMULATOR_PASSWORD` (a generated secret), the same way
  it seeds the bootstrap admin. If the account exists, its password and role
  are reset from config on every start: it's a service account, owned by
  configuration. The audit log shows "Scenario Simulator", never a person.
- **Why SYSTEM_ADMIN:** scenarios change hospital beds (HOSPITAL_ADMIN of
  that hospital), transformer readings (INFRASTRUCTURE_ADMIN) and disasters
  (EMERGENCY_OPERATOR). Only SYSTEM_ADMIN covers all three. Mitigations: only
  the gateway can reach the simulator (NetworkPolicy), only a SYSTEM_ADMIN can
  start anything, and background mode is off by default.
- **Rate limits:** the gateway allows 60 writes per minute per user. The
  simulator budgets itself to 40 per minute, and scenario steps go before
  background work.

## 2. Scenarios

Scenarios are data (`services/simulator-service/src/scenarios.js`): a
list of steps, each with a time offset, an action and a line of narration
for the screen.

| Scenario | ~Length | Shows |
|---|---|---|
| **Monsoon flood** | 4 min | report → hospitals fill up → transformer overheats → response plan approved → ambulances drive to the scene and back → severity rises → contained → resolved; hospitals and grid restored |
| **Earthquake, escalation** | 3 min | CRITICAL earthquake → plan sends what's in range and widens the search → follow-up plan → both approved → resolved |
| **Industrial fire, operator decides** | 2 min | plan proposed → the operator rejects it with a note → contained → resolved |

Step actions: `report`, `approvePlan` / `rejectPlan` (waits up to 30 s for
the plan), `updateDisaster`, `setStatus`, `hospitalSurge` / `hospitalRecover`
(available beds near the disaster), `transformerSpike` /
`transformerRecover`. A step that fails is shown as failed and the run
continues, because a demo shouldn't stop halfway. Stopping a run skips the
remaining steps but still runs its clean-up steps (recover hospitals and
transformers).

## 3. Background activity ("living city")

Off by default; switched on from the page, or for the length of a run. Every
10 s:

- **Ambulance trips:** every ambulance with a call advances one step:
  DISPATCHED → EN_ROUTE → driving towards the scene (location updates, so it
  moves on the map) → AT_SCENE → to the nearest hospital with free beds →
  AT_HOSPITAL → call completed → AVAILABLE. It uses the existing status
  machine and endpoints, at a demo speed of 8× real.
- **Telemetry:** one transformer per tick reports a normal reading (voltage
  and current within ±3 % of rated, load 40–75 %, 40–60 °C), so the power
  dashboard's trends move without raising alarms.

## 4. simulator-service

Node, port 8090, no database (a run's state lives in memory: one replica,
and a restart simply ends the run). API through the gateway at
`/api/v1/simulator`:

| Method | Path | Who |
|---|---|---|
| GET | `/scenarios` | any signed-in user |
| GET | `/status` | any signed-in user: the current run's steps, background mode, budget |
| POST | `/runs` `{scenarioId}` | SYSTEM_ADMIN |
| POST | `/runs/current/stop` | SYSTEM_ADMIN |
| POST | `/ambient` `{enabled}` | SYSTEM_ADMIN |

Frontend: a **Simulator** page (SYSTEM_ADMIN in the menu) with the scenario
cards, a live step timeline with the narration, Stop, and the background
switch.

## 5. Infrastructure

Compose service and Kubernetes Deployment (1 replica, no HPA), Service,
NetworkPolicy (gateway → simulator; simulator → gateway), Prometheus
scraping, gateway route + role rule + health check, the new secret
`SIMULATOR_PASSWORD` (generator, examples, Compose `.env`, Kubernetes
`secrets.env`), image build lists.

## 6. Tests

- Trip logic (pure): each status → next step, movement towards a target,
  arrival, choosing the hospital.
- Scenario runner with a fake clock and a fake API: step order and timing,
  waiting for a plan, a failed step doesn't stop the run, stop runs the
  clean-up.
- Gateway client: logs in again after a 401; the write budget holds back
  background work but not scenario steps.
- End to end on Kubernetes: run "Monsoon flood" start to finish, check the
  disaster's lifecycle, the plan, ambulances returning AVAILABLE, and
  hospitals and the grid restored.

## 7. As built: notes and changes from the design

- **Zero dependencies**, like resilience-service: Node's own `http` server
  and built-in `fetch`, the shared security modules, the same hand-rolled
  metrics. One replica with a `Recreate` rollout, so two simulators never run
  at once, not even during an update.
- **Background readings had to be much calmer than designed.** The first
  version (±2 % voltage, ±3 % current, a ±3-point random walk on load) set
  three healthy transformers to WARNING on the cluster: besides its fixed
  thresholds, power-service flags a reading more than ~2.5 standard deviations
  from the transformer's own recent mean, and the seeded history is very
  steady. Readings now use ±0.3 % voltage, ±0.6 % current, and load and
  temperature pulled 15 % of the way back to a calm point each time.
  Regression test: 500 readings fed back into themselves stay within 52–58 %
  load.
- power-service answers a reading with `{ telemetry: { status } }`; the
  transformer steps now report that status (they showed "reported").
- The simulator account is a SYSTEM_ADMIN, so it counts as an active admin:
  in principle the last *human* admin could be demoted while it remains.
  Accepted for a demo component; documented here.
- Background mode stays on after a scenario that switched it on, so
  ambulances finish their trips; switch it off on the page.

## 8. Verification

| What | Result |
|---|---|
| Node tests (`.\scripts\run-node-tests.ps1`) | 485 passed, 0 failed (458 before): simulator trips 13, runner + client + catalogue 13, plus the copy check |
| Kubernetes upgrade | all 16 deployments rolled out; auth-service logged `simulator service account ready`; `/health/services` reports all 10 services up |

### 8.1 Monsoon flood on the cluster (2026-10-24)

All 9 steps DONE in 210 s, run status COMPLETED. Sampled every 20 s, the
ambulances went through the whole trip on their own: 4 EN_ROUTE (moving on
the map) → AT_SCENE → TRANSPORTING → AT_HOSPITAL → calls completed → back to
8 of 10 available (the other two were already at a hospital / out of service).
The write budget peaked at 28 per minute (gateway limit 60). Against a baseline
taken before the run: hospital beds were exactly restored, the disaster
RESOLVED, and the plan was decided by the simulator's account, not a person.

### 8.2 Background mode after the fix

130 s with background on: 14 readings, 0 errors; every transformer NORMAL
again, and no reading from the new version flagged as anomalous.

### 8.3 Industrial fire

COMPLETED in 90 s: the plan was REJECTED with the operator's note, all its
actions SKIPPED, no ambulance moved, the disaster CONTAINED then RESOLVED.

### 8.4 Demo tips

Start **Monsoon flood** from the Simulator page, then switch to the Command
Center and Ambulances map while it runs: the narration on the Simulator page
tells you what to say at each step. The whole run takes about 3½ minutes.