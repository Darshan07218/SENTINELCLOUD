# Phase 18 — Real maps, bed-occupancy and transformer-risk forecasts

> **Status: done.** Design in §1–3, files in §4, tests in §5, verification in §6.

## 1. Maps

The roadmap planned to replace the schematic SVG maps with a real tiled
map. That had already happened in earlier phases: `frontend/src/components/LiveMap.jsx`
(Leaflet + react-leaflet, OpenStreetMap data, CARTO and Esri basemaps,
allowed by the CSP in `nginx/security-headers.conf`) draws every map: the
Command Center, Ambulances and Power. Phase 18 adds the one that was
missing, on the **Hospitals** page: every hospital at its real location,
coloured by its forecast risk (§2), and clicking one opens its trend.

## 2. Bed-occupancy forecast (hospital-service)

**History.** Hospitals only stored their current numbers, so there was
nothing to forecast from. Migration `0003_create_capacity_history.sql` adds
`hospital_capacity_history` and an `AFTER INSERT OR UPDATE` trigger on
`hospitals` that writes a row whenever beds or ICU numbers change. A trigger
rather than application code, so every path is recorded in the same
transaction as the change: the API, the disaster consumer, the response
engine's commands, or a manual SQL fix. Rows older than 30 days are deleted
at startup.

**Demo history.** A fresh install (or one from before this phase) has no
history. At startup `backfillCapacityHistory` (`src/db/seed.js`) gives each
hospital with at most one history row 72 hours of hourly, synthetic
history. It ends at the hospital's real current numbers: busy hospitals
have been filling up, quiet ones drift either way. A per-hospital seed makes
it the same on every install. Those rows have `source = 'backfill'`, and
every forecast reports `backfilledPoints`; the page says how many of the
points were synthetic.

**Method** (`src/services/forecast.js`, pure functions):

1. The history (one point per change) becomes an hourly series over the last
   7 days: the value in force at each hour, ending at the live numbers.
2. Damped Holt linear exponential smoothing: a level and a trend updated
   every hour (α 0.5, β 0.3), the trend damped by φ = 0.98 per hour so a
   short burst of admissions isn't extrapolated linearly for a day.
3. Forecast for 1…h hours (default 24, max 72) with an 80 % band that widens
   with √h from the one-step-ahead error. Clamped to 0–100 %.
4. Hours to the **90 % line**: the line where `capacity.js` raises a CRITICAL
   alert (fewer than 10 % of beds free). 0 if the hospital is already there.
5. Risk: CRITICAL if ≥ 97 % or crossing the line within 6 h; HIGH if ≥ 90 % or
   crossing it within the horizon; MODERATE from 75 %; otherwise LOW. A
   hospital's risk is the worse of beds and ICU.

Fewer than 6 hourly points → `INSUFFICIENT_DATA`: no forecast, current
numbers only.

**API** (GET, any signed-in role, like every other read):

| Route | Returns |
|---|---|
| `GET /api/v1/hospitals/forecast?horizonHours=24` | every hospital, highest risk first: current %, predicted %, trend per hour, hours to 90 %, risk, for beds and ICU |
| `GET /api/v1/hospitals/{id}/forecast?horizonHours=24` | the same plus the hourly `history[]` and `forecast[]` (`{at, pct, low, high}`) |

## 3. Transformer-risk forecast (power-service)

**Input:** a transformer's readings from the last 7 days (newest 500), its
failures in the last 30 days, its current status. No new tables: readings
were already stored (`transformer_readings`).

**Method** (`TransformerRiskForecaster`, pure like `ThresholdEngine`):

- Trend: least-squares line through load % and temperature against time.
  The projection starts from the latest reading and **never goes further
  ahead than the history behind it**: two hours of readings say nothing
  about tomorrow. Fewer than 3 readings or less than 1 hour of them →
  `INSUFFICIENT_DATA`, current values only.
- Hours until each metric reaches its CRITICAL line (`ThresholdEngine`:
  load 100 %, temperature 85 °C), if within what the history can see.
- Score 0–100: temperature, the higher of now and projected, from 45 °C to
  the 105 °C failure line → 40 points; load from 60 % to 150 % → 35; failures
  in the last 30 days (3+ count fully) → 15; share of anomalous readings → 10.
  FAILED scores 100.
- Level: LOW < 25 ≤ MODERATE < 50 ≤ HIGH < 75 ≤ CRITICAL. Reaching a critical
  line within the horizon makes it at least HIGH, within 6 h CRITICAL.
- Reasons in plain words ("Temperature rising 1 °C/h, critical in about
  10 h", "1 failure(s) in the last 30 days", …) and an hourly projection for
  the chart.

**API:**

| Route | Returns |
|---|---|
| `GET /api/v1/power/transformers/risk-forecast?horizonHours=24` | every transformer, highest score first, each with its full forecast and projection |
| `GET /api/v1/power/transformers/{id}/risk-forecast?horizonHours=24` | one transformer |

**Page:** the Power page gets a ranking (score bar, temperature and load now →
projected, time to critical) and, for the selected transformer, the
projection against both critical lines plus the reasons.

Both forecasts are decision support with a stated method, not trained
models: there is no real-world history to train on, and an operator can
check every number by hand.

## 4. Files

| Area | Change |
|---|---|
| `services/hospital-service/migrations/0003_create_capacity_history.sql` | new: history table + trigger |
| `services/hospital-service/src/services/forecast.js` | new: the forecaster |
| `services/hospital-service/src/db/seed.js`, `src/index.js` | demo backfill + 30-day retention at startup |
| `services/hospital-service/src/{repositories,services,routes,schemas}/…`, `src/openapi.yaml` | `capacityHistory`, `forecastCapacity`/`forecastAll`, two routes, `horizonHours` validation, API docs |
| `services/power-service/…/service/TransformerRiskForecaster.java` | new: the forecaster |
| `services/power-service/…/service/RiskForecastService.java` | new: loads readings and failures |
| `services/power-service/…/controller/{Analytics,Transformer}Controller.java`, `TransformerReadingRepository.java` | two routes, windowed reading query |
| `frontend/src/components/CapacityForecast.jsx` | new: hospital risk map, ranking, trend chart |
| `frontend/src/components/TransformerRiskPanel.jsx` | new: transformer ranking, projection, reasons |
| `frontend/src/pages/{Hospital,Power}Dashboard.jsx`, `lib/api.js`, `lib/statusTier.js`, `components/MiniCharts.jsx`, `styles.css` | wiring, `MODERATE` → yellow tier, `hideDots` for dense series, selectable rows |
| `scripts/verify-system.sh` | checks 4 and 7 also call the forecast endpoints |
| `tests/db/realPostgres.test.js` | trigger and backfill on real PostgreSQL |

## 5. Tests

| Suite | New |
|---|---|
| `hospital-service/tests/forecast.test.js` | hourly series, Holt, damping, risk levels, steady/filling/emptying/full hospitals, clamping, insufficient data, backfill determinism (21 tests) |
| `hospital-service/tests/hospitalRoutes.integration.test.js` | both routes: series, horizon, 400/404, headline-only list, auth (5 tests) |
| `power-service/…/TransformerRiskForecasterTest.java` | steady, rising temperature with ETA, critical within 6 h, no over-extrapolation, already critical, FAILED, failures + anomalies, too little history, no telemetry, OLS, levels (11 tests) |
| `tests/db/realPostgres.test.js` | the trigger writes a row per capacity change and none otherwise; the backfill runs once and every backfilled hospital gets an OK forecast (2 tests) |
| `scripts/verify-system.sh` | checks 4 and 7 call all four endpoints end to end |

**As built:** the first damping factor, φ = 0.9, capped any projected rise at
9 × the hourly trend: a hospital filling 0.6 %/h for two days was projected to
gain only 5 % in the next day. The unit test caught it; φ = 0.98 follows a
trend that has held for days and still flattens a short burst.

## 6. Verification (2026-10-25)

| Check | Result |
|---|---|
| hospital-service unit + route tests | 111 / 111 pass |
| power-service `mvn test` | 46 / 46 pass (11 new) |
| real-PostgreSQL suite (throwaway Postgres 16) | 46 / 46 pass (2 new); migration 0003 applies as `hospital_svc`, second run a no-op |
| frontend `vite build` | ok |
| Deploy to Docker Desktop Kubernetes | migration applied, 72 h backfilled for 8 hospitals, all deployments rolled out |
| `GET /hospitals/forecast` via the gateway | 8 hospitals: Jehangir and Noble CRITICAL (beds already above 90 %), Sassoon CRITICAL (ICU heading for 100 %), Deenanath MODERATE, four LOW |
| `GET /hospitals/{id}/forecast?horizonHours=6` | 73 hourly history points, 6 forecast points with band |
| `GET /power/transformers/risk-forecast` | 4 transformers, scores 1–6 (LOW), ~300 live simulator readings over 6.8 h each, reasons list the recorded failure and anomaly share |
| `horizonHours=99` / `horizonHours=0` | 400 / 400 |
| Deployed bundle | contains both new panels |
| GitHub CI run #10 (push, `85a5cc4`) | 17 / 17 push jobs green |
| GitHub CI run #11 (on demand, `85a5cc4`) | **18 / 18 green**, incl. the end-to-end system check (244 s), whose checks 4 and 7 now call all four forecast endpoints on a fresh Compose stack |
