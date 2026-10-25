# Phase 20 — Smarter response: impact estimate, bed reservations, forecast-aware choices

> **Status: done.** Design in §1–3, files in §4, tests in §5, verification in §6.

Until Phase 19 the response engine sized every plan from a fixed table
(HIGH → 4 ambulances, 4 blood units of each type, whatever the place), hospitals
only *reported* free beds, and power only reported transformers that had
already gone wrong. This phase makes the plan depend on **who lives in the
zone**, makes hospitals **hold** the beds a plan counts on, and feeds the
**Phase 18 forecasts** into the choices.

## 1. Impact estimate (`response-service/src/impact.js`)

From the disaster's type, severity, centre and radius:

1. **People in the zone.** A population-density model of Pune summed over a
   grid of cells across the circle: approximate Census 2011 densities
   (old-city peths 30,000 / km², Pune Municipal Corporation 12,500,
   Pimpri-Chinchwad 9,500, urban fringe 2,000, rural 350). The PMC circle
   comes out at ≈ 3.5 M (census: 3.1 M), PCMC at 1.74 M (census: 1.73 M).
2. **Exposed.** The share of them this kind of event actually reaches: flood
   5 % (low-lying areas), fire 5 %, earthquake 50 %, cyclone 25 %, landslide
   2 %, industrial accident 10 %.
3. **Casualties.** Per 10,000 exposed at MEDIUM (flood 3, fire 2, earthquake 1,
   cyclone 1, landslide 20, industrial 4) × a steep severity multiplier
   (LOW 0.2, MEDIUM 1, HIGH 4, CRITICAL 15): casualties grow much faster than
   intensity. Calibrated so a MEDIUM (≈ M5) quake under the city gives ~250
   casualties, a CRITICAL one thousands, a local fire tens.
4. **Needs.** 40 % of casualties need a bed, 10 % ICU, 25 % an ambulance
   (4 trips per ambulance in the first hours; first wave capped at 10, the
   most one dispatch command may ask for); 2 red-cell units per ICU patient,
   split over O- and O+.

The **severity table stays as the floor**: a plan never asks for less than it
did in Phase 15. The estimate is shown on the plan ("~3.7 M people within
10 km, ~186,000 exposed, ~223 casualties…") and stored with it
(`needs.impact`). It is a **demo model**: every number is in one file, and
`GET /api/v1/response/playbook` returns them (`impactModel`).

| Example (centre of Pune) | Casualties | Beds | ICU | Ambulances |
|---|---|---|---|---|
| FIRE HIGH, 2 km | 15 | 6 | 2 | 1 |
| FLOOD HIGH, 10 km | 223 | 90 | 23 | 10 (capped) |
| EARTHQUAKE MEDIUM, 15 km | 252 | 101 | 26 | 10 |
| EARTHQUAKE CRITICAL, 30 km | 5,767 | 2,307 | 577 | 10 + mutual-aid notice |

## 2. Bed reservations (hospital-service)

A plan now holds beds the way it already reserved blood:

- **`command.hospital.reserve-beds`** `{ hospitalId, beds, icuBeds }`: in one
  transaction, lock the hospital row, take up to that many off its free
  counts, record a `bed_reservations` row (HELD), and raise a capacity alert
  through the outbox if the hospital is now short. If beds filled up since the
  plan was made, fewer are held and the reply says so; none free is a failure.
  The Phase 18 history trigger records the drop, so the forecast sees it.
- **`command.hospital.release-beds`** `{ reservationId }` (plan undo): give the
  beds back (never above the hospital's total); releasing twice is harmless.
- **Exactly once**: the shared command processor (Phase 15) stores each
  command's reply; the reservation also remembers its command id, so a crash
  between holding and replying can't hold the beds twice.
- `GET /api/v1/hospitals/reservations?status=HELD|RELEASED&hospitalId=` lists them.

**Spreading beds over hospitals** (`allocateBeds` in the playbook): healthy
hospitals first, nearest first; then ones the forecast says fill up soon;
overloaded ones last. A hospital never gives more than **80 % of its free
beds** to one plan (the rest stays for everyday patients), at most 6
hospitals per round. Whatever can't be held becomes a **bed-shortfall
notice**; a follow-up plan after widening the radius asks only for the beds
still missing, and not again at a hospital that refused. Blood now goes to
the hospital holding the most beds.

## 3. Forecast-aware choices

- **Hospitals.** The hospital reaction now carries each nearby hospital's 24 h
  forecast (`forecast: { risk, bedsPredictedPct, hoursToFull }`, Phase 18). A
  hospital whose forecast is CRITICAL or full within 6 hours is asked after
  the others, for beds and as the receiving hospital for blood.
- **Power.** The power reaction now also lists the transformers in the zone
  whose 24 h risk score is **50 or more** (`forecastAtRiskTransformers`,
  Phase 18), even if they are still NORMAL. The line-crew notice names them
  ("1 more flagged by the risk forecast (TXF-SHV-02 62/100)").

Both are best effort: a forecast that fails is left out and never blocks the
reaction.

## 4. Files

| Area | Change |
|---|---|
| `response-service/src/impact.js` | new: population model, casualties, needs |
| `response-service/src/playbook.js` | `combineNeeds`, `rankHospitals`, `allocateBeds`, `fillsSoon`; bed actions, estimate notice, bed-shortfall and forecast power notices |
| `response-service/src/services/responseService.js` | impact estimate per plan (injectable), bed commands and undo, hospital-service as executor |
| `response-service/src/routes/responseRoutes.js` | `impactModel` in `GET /playbook` |
| `hospital-service/migrations/0004_bed_reservations.sql` | `processed_commands`, `bed_reservations` |
| `hospital-service/src/services/reservations.js`, `consumers/commandConsumer.js`, `commands.js` (shared copy), `index.js`, `routes`, `events/eventTypes.js` | reserve/release, command queue `q.hospital.commands`, `GET /reservations` |
| `hospital-service/src/consumers/disasterConsumer.js` | forecast per nearby hospital in the reaction |
| `power-service/…/event/DisasterEventListener.java` | `forecastAtRiskTransformers` from `RiskForecastService` |
| `k8s/base/config/rabbitmq-set-policies.sh` | `q.hospital.commands` dead-lettered like the other command queues |
| `frontend/src/components/ResponsePlanPanel.jsx` | estimate tiles, bed actions and their outcomes |
| `scripts/sync-shared-broker.{sh,ps1}`, `shared/node-broker/tests/copies.test.js` | `commands.js` copy for hospital-service |
| `scripts/verify-system.sh` | check **15 Smarter response** |

## 5. Tests

| Suite | New |
|---|---|
| `response-service/tests/impact.test.js` | population vs census, density order, monotonic radius; casualties steep in severity, MEDIUM quake hundreds, city vs countryside, small fire small; table as floor; `fillsSoon`; hospital order; 80 % cap and order of allocation; shortfall; plan: estimate notice first, ambulances from the estimate, beds at the hospital not filling up, blood follows beds, forecast power notice, revision 2 only the missing beds and not at a refusing hospital (19) |
| `response-service/tests/engine.test.js` | `deliveredBy` counts held beds and refusing hospitals; reserve and release commands (+2) |
| `hospital-service/tests/commandConsumer.test.js` | reply shape, NO_CAPACITY is a command failure, a database error is retried, release idempotent (4) |
| `power-service` `DisasterEventListenerTest` | forecast-flagged transformers listed, highest score first, a failing forecast skipped (+1) |
| `tests/db/realPostgres.test.js` | reservation: free count drops, history recorded, idempotent per command, release restores, double release harmless; six concurrent reservations never take more than free, then NO_CAPACITY; full engine path with the estimate: beds at the healthy hospital, command sent, plan completes, undo sends releases (3) |
| `scripts/verify-system.sh` check 15 | end to end on a fresh stack: plan with estimate and bed actions, approve → beds HELD in hospital-service, undo → RELEASED |

**As built:**

- The first casualty rates (e.g. 30 per 10,000 for earthquakes, ×6 at
  CRITICAL) gave 9,000 casualties for a MEDIUM quake and 355 for a 2 km fire.
  They were recalibrated against orders of magnitude (§1) before anything was
  committed.
- The engine's Phase 15 database tests pin exact action lists on the severity
  table; with the estimate always on they failed (6 tests) because plans gained
  a notice and bed actions. The estimator is now injected
  (`createResponseService({ estimate })`, default `estimateImpact`); those tests
  pass `estimate: null`, and a separate test covers the Phase 20 path.
- **A real Phase 15 race, exposed here.** On the cluster the first approved
  plan stayed EXECUTING although every action had its result. Replies for one
  plan arrive almost together (prefetch 10), each in its own transaction, and
  each checked "anything still pending?" before the other had committed: both
  saw the other PENDING, so neither closed the plan. Phase 20 made it likely by
  sending more commands to more services at once. Fix: a reply now locks the
  plan row before its action (the order approve and undo use, so no deadlock),
  and the sweep closes any plan whose actions have all finished, as a safety
  net. A regression test sends all replies at the same moment; with the lock
  removed it fails, with it the plan completes. On the cluster the new sweep
  closed the stuck plan (PARTIAL) within seconds of the rollout.

## 6. Verification (2026-10-25)

| Check | Result |
|---|---|
| response-service tests | 53 / 53 (19 new impact/playbook, 2 new engine) |
| hospital-service tests | 115 / 115 (4 new) |
| power-service `mvn test` | 47 / 47 (1 new) |
| all Node suites | 564 pass, 0 fail |
| real-PostgreSQL suite | 57 / 57 (5 new); the concurrency test fails without the fix |
| Deploy to Docker Desktop Kubernetes | migration 0004 applied; `q.hospital.commands` bound and dead-lettered |
| HIGH flood (demo detection, confirmed) | estimate: ~4.6 M people within 15 km, ~230,000 exposed, ~276 casualties → 111 beds, 28 ICU, 10 ambulances (7 in range: 7 sent + radius widened) |
| Approve | 111 beds + 28 ICU held at Command Hospital Southern Command; network free beds 984 → 873; blood reservations failed legitimately (no single batch of 28 O-/O+ units), plan PARTIAL; follow-up plan proposed for the wider radius |
| Undo | reservation RELEASED, network free beds back to 984, plan ROLLED_BACK; resolving the disaster expired the follow-up; 0 beds left held |
