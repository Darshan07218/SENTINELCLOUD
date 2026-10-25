# Phase 19 — Automatic disaster detection

> **Status: done.** Design in §1–3, files in §4, tests in §5, verification in §6.

Until now a disaster entered SentinelCloud only when a person reported it
(or the simulator played a scripted one). Everything after that was
automatic. This phase automates the first step: **intake-service** watches
public earthquake and weather feeds for the city and raises disasters
itself, with a person in the loop for everything that isn't clearly severe.

## 1. Flow

```
USGS earthquakes ─┐                                   ┌─ CRITICAL → auto-confirmed ─┐
                  ├─▶ intake-service ─▶ detection ─────┤                             ├─▶ POST /disasters (via the gateway,
Open-Meteo rain  ─┘   (every 2 / 30 min)  (stored once) └─ others → PENDING → operator ┘     intake's own service account)
& wind                                                       confirms / dismisses              │
                                                                                               ▼
                                         disaster.detected → hospitals, ambulances, blood, power react
                                         → situation report → response engine proposes a plan (Phase 15)
```

- **Through the gateway, like a person.** intake-service never writes to
  disaster-service directly. It logs in with its own service account
  (`INTAKE_EMAIL` / `INTAKE_PASSWORD`, seeded by auth-service) whose role is
  **EMERGENCY_OPERATOR**, the least role that may create disasters. Every
  creation passes the same authentication, role check, rate limit and audit
  log as an operator's click; the audit log shows that account, never a
  person.
- **Stored once.** Each detection is keyed by `(source, external_id)` (the
  USGS event id; for weather, kind + day + severity). Polling the same
  event again, from a restart or from a second replica, is a no-op.
- **A person decides, unless it is severe.** `AUTO_CONFIRM_MIN_SEVERITY`
  (default `CRITICAL`; `NONE` turns it off) decides what becomes a disaster
  on its own. Everything else waits on the **Auto-Detection** page for an
  EMERGENCY_OPERATOR or SYSTEM_ADMIN to confirm or dismiss it, and expires
  after 12 hours without a decision.
- **Two clicks, one disaster.** Confirming first claims the detection
  (`PENDING`/`FAILED` → `CONFIRMING`) in a single conditional UPDATE, then
  calls the API. Of two simultaneous confirms exactly one creates a
  disaster; the other gets 409. If the API call fails the detection becomes
  `FAILED` with the error and can be confirmed again; a confirm interrupted
  by a pod restart is turned into `FAILED` after 5 minutes.

## 2. Sources and rules

| Source | What | Rule |
|---|---|---|
| **USGS** real-time feed (`2.5_day.geojson`, free, no key), every 2 min | earthquakes M2.5+ worldwide, last 2.5 days | within `WATCH_RADIUS_KM` (500) of the city and ≥ `WATCH_MIN_MAGNITUDE` (3.0). Severity by magnitude: ≥ 6.5 CRITICAL, ≥ 5.5 HIGH, ≥ 4.5 MEDIUM, else LOW; one step lower beyond 250 km. Radius ≈ where it is felt: 15 km at M3, doubling per magnitude, max 500 km. Placed at the epicentre. |
| **Open-Meteo** forecast (free, no key), every 30 min | next 24 h of rain and wind gusts at the city centre | rain ≥ 64.5 mm (IMD "heavy") → FLOOD MEDIUM, ≥ 115.6 mm ("very heavy") → HIGH, ≥ 204.5 mm ("extremely heavy") → CRITICAL. Gusts ≥ 62 km/h (gale) → CYCLONE MEDIUM, ≥ 89 (storm) → HIGH, ≥ 118 (hurricane force) → CRITICAL. Radius 25 km. |
| **DEMO** (SYSTEM_ADMIN only) | an injected, clearly labelled detection | real quakes and storms near Pune are rare, so a demo detection goes through exactly the same pipeline, policy included. |

The page also shows each source's last reading even when nothing is
detected (quakes in range, rain and gusts expected), and a feed that is
down is shown as ERROR with its message. A feed outage never makes the
service unready: the API keeps working.

## 3. API (gateway prefix `/api/v1/intake`)

| Route | Who |
|---|---|
| `GET /overview` (watch area, policy, each source's status and reading) | any signed-in user |
| `GET /detections?status=&limit=`, `GET /detections/{id}` | any signed-in user |
| `POST /detections/{id}/confirm`, `POST /detections/{id}/dismiss` (`{note?}`) | EMERGENCY_OPERATOR, SYSTEM_ADMIN |
| `POST /poll` (poll every source now) | EMERGENCY_OPERATOR, SYSTEM_ADMIN |
| `POST /demo` (`{type, severity}`) | SYSTEM_ADMIN |

Metrics: `sentinel_intake_detections{source,status}`,
`sentinel_intake_detections_new_total{source,type,severity}`,
`sentinel_intake_source_up{source}`.

## 4. Files

| Area | Change |
|---|---|
| `services/intake-service/` | new service: sources (`usgs.js`, `openMeteo.js`), engine, repository, routes, gateway client, migration `0001_create_detections.sql`, Dockerfile, tests |
| `services/auth-service/src/db/seed.js`, `index.js` | service-account seeding generalised; intake account (EMERGENCY_OPERATOR) |
| `services/gateway/src/{index,routeAccessRules}.js` | `/intake` route; writes for EMERGENCY_OPERATOR and SYSTEM_ADMIN |
| `k8s/base/apps/intake-service.yaml`, `kustomization.yaml`, `gateway.yaml`, `auth-service.yaml`, `infrastructure/postgres.yaml`, `security/network-policies.yaml`, `overlays/local/kustomization.yaml` | Deployment + Service, `intake_db` + role, gateway ↔ intake NetworkPolicies, image |
| `docker-compose.yml`, `infrastructure/prometheus/prometheus.yml` | the service, its database, scrape target |
| `.env.example`, `k8s/overlays/local/secrets.env.example`, `scripts/generate-secrets.sh` | `INTAKE_DB_PASSWORD`, `INTAKE_EMAIL`, `INTAKE_PASSWORD` |
| `frontend/src/pages/DetectionPage.jsx`, `App.jsx`, `lib/api.js` | **Auto-Detection** page (sources, pending decisions, map, demo form, history) |
| `scripts/verify-system.sh` | check **14 Automatic detection**; 8 databases/roles in check 2 |
| CI, image scripts, `run-db-tests.sh`, `sync-shared-security.sh`, copies test, `tests/db/realPostgres.test.js` | intake added to every service list |

## 5. Tests

| Suite | New |
|---|---|
| `intake-service/tests/sources.test.js` | magnitude/distance severity, felt radius, filtering by distance, magnitude and event type, IMD rain bands, gust bands, dedup ids (10) |
| `intake-service/tests/engine.test.js` | dedup across polls, failing feed recorded, weather reading stored, auto-confirm through the gateway, policy levels, concurrent confirms → one disaster, failed API → FAILED → retry, dismiss/409/404, CRITICAL demo auto-confirmed, overview, unset settings keep defaults (11) |
| `intake-service/tests/routes.test.js` | auth, reading for every role, demo admin-only + validation, confirm by operator not citizen, 409, dismiss, 404/400, poll for operators (6) |
| `tests/db/realPostgres.test.js` | migration as `intake_svc`; concurrent inserts store once; five concurrent claims → one; CHECK constraints; expiry and stuck-confirm recovery; source status keeps the last good reading (6) |
| `scripts/verify-system.sh` check 14 | end to end: overview, HIGH confirmed → disaster with the auto-detected label, second confirm 409, CRITICAL auto-confirmed, LOW dismissed, created disasters resolved |

**As built:** the first deploy logged `USGS poll failed: Failed to parse URL
from undefined`. With no `USGS_FEED_URL` set, the entry point passed
`url: undefined`, and the spread `{ url: DEFAULT, ...settings }` replaced the
default with it. Unset settings are now dropped before merging, and a
regression test covers it.

## 6. Verification (2026-10-25)

| Check | Result |
|---|---|
| intake-service tests | 27 / 27 |
| all Node suites (`run-node-tests.sh`) | 538 pass, 0 fail (before the regression test) |
| real-PostgreSQL suite | 52 / 52 (6 new) |
| frontend build | ok |
| Deploy to Docker Desktop Kubernetes | `intake_db` and role created on the existing Postgres, intake account seeded, pod ready |
| Live feeds on the cluster | USGS and Open-Meteo polled without error; Pune: 0 mm rain and gusts up to 34 km/h forecast, no M3+ quake within 500 km in 2.5 days, so no real detection (correct) |
| HIGH demo → confirm | disaster created (`[Auto-detected · DEMO] …`), 4/4 services reacted, the response engine proposed a plan; second confirm 409 |
| CRITICAL demo | AUTO_CONFIRMED, disaster created |
| LOW demo → dismiss | DISMISSED, nothing created |
| Gateway audit log | both creations by the intake account (EMERGENCY_OPERATOR), not the admin who clicked |
| GitHub CI run #14 (push, `25b7c75`) | 18 / 18 push jobs green, incl. the intake-service image |
| GitHub CI run #16 (nightly, `25b7c75`) | **19 / 19 green**, incl. the end-to-end system check (250 s) with the new check 14 on a fresh Compose stack |

Run #15 (started by hand) was cancelled by the nightly run #16, which began a
minute later: both were in the same concurrency group. The workflow's group
now includes the event, so a manual, nightly and push run never cancel one
another.
