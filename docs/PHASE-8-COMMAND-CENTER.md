# Phase 8 — SentinelCloud Command Center

> **Note (Phases 12–13).** Commands and behaviour in this phase document
> predate the security hardening and the engineering review. Notably: sign-up
> always creates a `CITIZEN` (no `role` field), the refresh token is an
> httpOnly cookie (login returns `accessToken`, not `session.accessToken`),
> every service except `/auth/docs` requires a Bearer token, and secrets come
> from `./scripts/generate-secrets.sh`. Current commands:
> [`SYSTEM-REFERENCE.md`](SYSTEM-REFERENCE.md), [`../SECURITY.md`](../SECURITY.md).


## Goal

One unified React dashboard that feels like a real emergency
operations center: every domain built in Phases 3–7 (hospitals,
ambulances, blood banks, power infrastructure, disasters, and the live
event bus) rolled up into a single screen, with consistent color
coding, real charts, cross-cutting filters, and automatic updates when
new events occur on the bus.

This phase touched **only the frontend** — no backend service, schema,
or API changed. Every one of the eleven required sections is built
entirely from REST endpoints and the WebSocket feed that Phases 3–7
already shipped. That was a deliberate test of whether those five
phases' worth of API surface was actually sufficient to build a real
aggregate dashboard on top of — it was, with zero gaps.

---

## "Do not use fake static dashboard values" — how that was enforced

Every number, chart, marker, and status badge on this page is either:

1. Read directly from a `useState` that's set from a real
   `fetch`/`authFetch` response (see `loadAll()`), or
2. A `useMemo` computed **from** that state (chart data, map points,
   filtered lists, the global status roll-up) — never a literal.

There is not one hardcoded count, percentage, or status anywhere in
`CommandCenter.jsx`. Every panel's loading state is an explicit
"Loading…" (rendered while its backing state is still `null`), and
every empty state is an explicit "No data" message — the alternative
(silently showing `0` or a placeholder number before the real data
arrives) is exactly the kind of fake-looking static value the
requirement called out, so it was avoided throughout.

---

## The eleven sections, and what backs each one

| # | Section | Backend source(s) |
|---|---|---|
| 1 | Global system status | Rolled up (worst tier) from gateway health, every service's health, active disaster severities, all alerts, hospital emergency statuses, and power substation statuses — see "Global status roll-up" below |
| 2 | Active disaster events | `GET /disasters/active` |
| 3 | Interactive map | `GET /hospitals`, `GET /ambulances`, `GET /blood-banks`, `GET /power/map`, `GET /disasters/active` — five real endpoints combined into one point set |
| 4 | Hospitals | `GET /hospitals/stats/summary` |
| 5 | Ambulances | `GET /ambulances/stats/summary`, `GET /ambulances/emergencies/active` |
| 6 | Blood banks | `GET /blood-banks/stats/summary` |
| 7 | Power infrastructure | `GET /power/stats/summary`, `GET /power/map` |
| 8 | Alerts | `GET /hospitals/alerts`, `GET /blood-banks/alerts`, `GET /power/alerts`, `GET /disasters/active` — normalized into one feed |
| 9 | Event timeline | `GET /notifications/events/recent` (bootstrap) + `/ws/live` (live) |
| 10 | Service health | `GET /health` (gateway) + `GET /health/services` |
| 11 | Infrastructure statistics | Every `stats/summary` endpoint above, in one grid |

Nothing here is a new backend capability — every one of these
endpoints already existed before this phase started (most since
Phases 3–6; the disaster and event endpoints since Phase 7).

---

## The 4-tier color system

The spec was explicit: **GREEN = NORMAL, YELLOW = WARNING, ORANGE =
HIGH, RED = CRITICAL** — applied consistently. The problem: every
domain in this project already has its own status vocabulary, and none
of them use exactly those four words:

- Hospital `emergencyStatus`: `NORMAL` / `ELEVATED` / `OVERLOADED`
- Power `InfraStatus`: `NORMAL` / `WARNING` / `CRITICAL` / `FAILED`
- Disaster & alert `severity`: `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`
- Ambulance fleet `status`: `AVAILABLE` / `DISPATCHED` / `EN_ROUTE` / `AT_SCENE` / `TRANSPORTING` / `AT_HOSPITAL` / `OUT_OF_SERVICE`
- Service health: `ok` / `up` / `ready` / `degraded` / `down` / `not_ready`

`frontend/src/lib/statusTier.js` is the one place that normalizes all
of them onto the same four tiers via an explicit lookup table
(`RAW_TO_TIER`), so a hospital's `ELEVATED`, a power transformer's
`WARNING`, and a disaster's `HIGH` all render with the exact same
color when they mean roughly the same thing. This is used by **every**
section — the map markers, the alert badges, the disaster list, the
gauge bars, the chart bar colors, the service-health grid, and the
global status banner — so the color language is consistent across the
whole screen, not just within one panel.

Two judgment calls worth documenting:
- `FAILED` (power) and `OVERLOADED` (hospital) both map to `CRITICAL`
  — there's no fifth color for "worse than critical," and both really
  do mean "this asset can't do its job right now."
- Ambulance states that mean "busy doing its job" (`DISPATCHED` through
  `AT_HOSPITAL`) all map to `WARNING`, not because they're a problem,
  but because they're not immediately *available* — that's a genuinely
  useful signal on an ops dashboard ("how much of my fleet can I use
  right now") distinct from `OUT_OF_SERVICE` (`CRITICAL`, actually
  broken/unusable).

### Global status roll-up

The banner at the top computes `worstTier()` over every signal the
dashboard has: gateway health, every service's health, every active
disaster's severity, every alert's severity, every hospital's
emergency status, and every substation's worst-transformer status.
One red anywhere in the system turns the whole banner red — the same
"worst of everything" logic `InfraStatus.worstOf` used within
power-service alone (Phase 6) applied here across the entire platform.

---

## Charts (5 required, all real-data)

| Chart | Where | Data |
|---|---|---|
| Hospital capacity | Hospitals panel | `GaugeBar`s for bed occupancy % and ICU occupancy %, from `hospitals/stats/summary` |
| Ambulance availability | Ambulances panel | `DonutChart` of the 7-state fleet breakdown, from `ambulances/stats/summary` |
| Blood inventory | Blood Banks panel | `BarChart` of units available per blood type, from `blood-banks/stats/summary`'s `unitsByType` |
| Power load | Power panel | `GaugeBar` for average transformer load % (computed client-side from every transformer in `power/map`) + `BarChart` of transformer counts by status |
| Active incidents | Active Disasters panel | `BarChart` of all recorded disasters grouped by severity, from `GET /disasters` |

`BarChart`, `DonutChart`, and `GaugeBar` (`frontend/src/components/MiniCharts.jsx`)
are dependency-free inline SVG, following the exact same "no charting
library" approach `PowerDashboard.jsx` established in Phase 6 —
generalized here into shared components so five different panels don't
each reinvent bar-chart SVG math.

---

## The interactive map

`frontend/src/components/CommandMap.jsx` combines **five** real
position sources into one schematic (non-tiled) SVG map, the same
"project lat/lng into a bounding-box-sized viewBox" approach every map
in this project has used since Phase 4's ambulance `FleetMap`:

- Hospitals (circle markers, colored by `emergencyStatus`)
- Ambulances (triangle markers, colored by fleet `status`)
- Blood banks (diamond markers, colored by whether any shortage alert
  references that bank)
- Power substations (square markers, colored by worst transformer status)
- Active disasters (star markers, plus a dashed radius circle showing
  the actual `radiusKm` affected zone from the disaster record)

"Interactive" here means: hover any marker for its name and status,
click to pin it (shows a detail card below the map), and the
infrastructure-type filter genuinely shows/hides layers rather than
just relabeling something. A real tiled/pannable map (Leaflet) remains
explicitly future work — see `docs/ROADMAP.md` phase 9 — this phase's
map is honest about being schematic rather than pretending otherwise.

---

## Filtering

Four filters, in one shared bar, each with a real effect:

- **Location** (free-text): substring-matches against every entity's
  name/address/description across the map, the alerts feed, and the
  active-disasters list simultaneously.
- **Severity** (`NORMAL`/`WARNING`/`HIGH`/`CRITICAL`, via the same
  `toTier()` normalization): filters the map markers, the alerts feed,
  and the active-disasters list to only that tier.
- **Infrastructure type** (Hospitals/Ambulances/Blood Banks/Power
  Grid/Disasters): controls which map layers are visible and which
  alert sources appear in the Alerts panel.
- **Time range** (15 min / 1 hour / 24 hours / all time): filters the
  Event Timeline to events whose `occurredAt` falls within the window.

All four combine (e.g. "CRITICAL severity, Power Grid only, containing
'substation'" narrows the map and alerts together) because they're
implemented as composable predicate functions (`matchesLocation`,
`matchesSeverity`) applied identically everywhere they're relevant,
not four separate ad-hoc filters that could drift out of sync.

---

## "Updates automatically when new events occur"

Reuses the exact live-feed mechanism Phase 7 built for the Emergency
Dashboard (`lib/socket.js`'s `connectLiveFeed`, connecting to
`/ws/live`) — but goes one step further than that page did:

1. Every event frame is appended to the Event Timeline immediately
   (no delay).
2. Every event frame **also** triggers a debounced (1.2s) full
   `loadAll()` — so when a `disaster.detected` fires, not just the
   timeline but the active-disasters list, the alerts feed, the map,
   and the global status banner all pick up the change shortly after,
   without a manual refresh. The debounce means a fast burst of five
   reaction events (the normal Phase 7 fan-out pattern) triggers one
   reload, not five.
3. A 20-second polling fallback (`setInterval(loadAll, 20000)`) keeps
   the dashboard fresh even if the WebSocket connection is temporarily
   down — `connectLiveFeed` auto-reconnects, but the polling loop means
   the numbers on screen are never more than 20 seconds stale even in
   the worst case.

---

## Files created

```
frontend/src/lib/statusTier.js
frontend/src/components/MiniCharts.jsx   (BarChart, DonutChart, GaugeBar)
frontend/src/components/CommandMap.jsx
frontend/src/pages/CommandCenter.jsx
docs/PHASE-8-COMMAND-CENTER.md (this file)
```

## Files modified

- **`frontend/src/App.jsx`** — `CommandCenter` is now the default route
  (`/`); the previous default (`SystemHealthDashboard`, a lower-level
  technical health/session-debug view) moved to `/system-health` and
  stayed in the nav under its own link — nothing from Phase 1 was
  removed, just no longer the landing page. Added "Command Center" as
  the first nav link.
- **`docs/ROADMAP.md`** — Phase 8 marked done; renumbered the two
  already-superseded phases' successors accordingly.

**Not modified:** every backend service, every migration, the gateway,
docker-compose.yml. This phase is proof that Phases 3–7's API surface
was already complete enough to build a real aggregate dashboard
without needing a single new backend endpoint.

---

## Verification

```bash
cd sentinelcloud/frontend
npm install
npm run build
```

**Actually run in this environment: passes with zero errors.**
`✓ 49 modules transformed` (up from 45 before this phase — the four
new files), output bundle `249 kB` (`73 kB` gzipped). This is the same
level of verification every frontend change in Phases 5–7 received —
a real Vite production build, not just a read-through.

`node --check` was also run against every new file (`statusTier.js`
passes directly; the two `.jsx` files require Vite/Babel's JSX
transform, which is exactly what the full `npm run build` above
exercises).

No new backend code was written this phase, so there's nothing new to
run `npm test` or `mvn test` against — every existing test suite from
Phases 3–7 is unaffected (no service source changed).

### Manual check of the data-shape assumptions

Before writing `CommandCenter.jsx`, every response shape it consumes
was re-read directly from the actual route/controller source in each
service (not from memory or the earlier phase docs) — for example,
`GET /blood-banks/stats/summary`'s `unitsByType` map, `GET /power/map`'s
per-substation `transformers[].loadPercentage`, and
`GET /ambulances/emergencies/active`'s `{ emergencies, count }`
envelope were each confirmed against their controller/route code
before being referenced in the frontend. This is the same kind of
cross-check that caught real bugs in earlier phases (the `Map.of`
5-pair limit in Phase 7) — done here on the read side instead of the
write side.

---

## Demonstration

```bash
cd sentinelcloud
docker compose up --build
```

Then in the browser: log in and land directly on the Command Center at
`/`.

1. **Global status banner** — should read NORMAL (green) on a freshly
   seeded stack with no disasters yet.
2. **Interactive map** — every seeded hospital, ambulance, blood bank,
   and substation from Phases 3–6's demo data should appear as a
   colored marker; try the infrastructure-type filter to isolate one
   layer.
3. Open the **Emergency** page in a second tab and submit a disaster
   (as an `EMERGENCY_OPERATOR`) — within a couple of seconds, watch the
   Command Center tab's Event Timeline receive `disaster.detected`
   followed by the four reaction events, the Active Disasters panel
   populate, the Alerts panel gain a `CRITICAL` entry, the map gain a
   star marker with its radius circle, and the global status banner
   turn red — all without touching the Command Center tab.
4. Try the **severity filter** set to `CRITICAL` — the map, alerts, and
   active-disasters list should all narrow to just that disaster.
5. Try the **location filter** with a hospital's name or city — the
   map and alerts should narrow accordingly.

---

## Known limitations

- **Schematic map, not tiled/pannable** — consistent with every other
  map in this project so far; real Leaflet integration is the next
  roadmap phase.
- **Blood bank map-marker status is alert-derived, not a first-class
  field** — blood-bank-service doesn't track a bank-level status enum
  the way hospitals/power do, so the map infers NORMAL/WARNING/CRITICAL
  for a bank from whether any shortage alert currently references it.
  This is a reasonable proxy but not the same as a stored status.
- **Event timeline time-range filter uses client-side event arrival
  time**, bounded by whatever `GET /notifications/events/recent`
  returns (capped at 200 events server-side, per Phase 7) plus
  whatever has arrived live since — a "24 hours" filter on a
  freshly-started stack will only show what's actually happened in
  that time, which on a demo environment may be much less than 24
  hours of real history.
- **No per-panel manual refresh button** — every panel relies on the
  shared 20-second poll + live-feed-triggered reload; there's no way
  to force just one panel to refetch immediately without triggering
  the full `loadAll()`. Given the reload is already fast and
  debounced, this was judged not worth the added UI complexity.
