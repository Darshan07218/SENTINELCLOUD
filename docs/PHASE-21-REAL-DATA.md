# Phase 21 — Real data

> **Status: done.** What is real, what is estimated, and how it is built, in §1–4; tests and verification in §5–6.

Until Phase 20 every facility was sample data: eight hand-written hospitals,
three blood banks and three substations, and the impact estimate used a few
hand-made density zones. This phase replaces them with open data, and says
precisely which numbers are still estimates.

| Data | Before | Now | Still estimated |
|---|---|---|---|
| Hospitals | 8 hand-written | **101 real Pune hospitals** from OpenStreetMap: names, locations, addresses, phone numbers, emergency departments | Bed, ICU and ventilator counts (OSM records beds for 1 of them); starting availability |
| Substations | 3 invented | **31 real substations** from OpenStreetMap: names, locations, operators, voltages | Transformers and their telemetry (not public) |
| Blood banks | 3 at hand-picked coordinates | At **real host hospitals** (Sassoon, KEM, Deenanath Mangeshkar), OSM location and address | Stock, batches, demand history (OSM has no blood banks for Pune) |
| Ambulances | Around the old sample hospitals | Stationed at **real hospitals with an emergency department**, largest first | Vehicles and crews (fleet data isn't public) |
| Population (impact estimate) | 4 density zones from Census 2011 | **WorldPop 2020 1 km grid**, ±110 km around Pune (≈ 38.7 M people, incl. part of the Mumbai region) | — (zones remain the fallback outside the grid) |
| Earthquakes, weather | Real since Phase 19 (USGS, Open-Meteo) | unchanged | — |

## 1. Snapshots, not live calls

`tools/real-data/build-snapshots.mjs` queries OpenStreetMap (Overpass API)
once and writes dated, attributed files to `data/real/`, plus a copy in each
service that seeds from them (each service is its own Docker build context).
Services never call OpenStreetMap at runtime: every install seeds the same
data, offline. `tests/data/snapshots.test.js` fails if a copy drifts from
`data/real/`, or if a record breaks an invariant (inside Pune, available ≤
total, an OSM id, a stated capacity source). Re-run the tool to refresh.

The tool retries the public Overpass servers (they answer 429/502/504 under
load) and alternates with a mirror.

## 2. Selecting hospitals

OpenStreetMap has 998 places tagged `amenity=hospital` in Pune district, most
of them small clinics. Selected: named, within 20 km of the centre, and

- mapped as a building or campus, **or** tagged `emergency=yes`, **or** with a `beds` tag;
- **plus** a short, documented allowlist (`MAJOR_POINTS`) of major hospitals
  OSM maps only as an untagged point: B. J. Medical College and **Sassoon**
  Hospital, and **Command Hospital** (Southern Command);
- **minus** specialist facilities (eye, dental, veterinary, AYUSH,
  diagnostics…);
- records within 120 m merged (the same hospital mapped in English and
  Marathi, or as a point and a building).

Result: 101 hospitals, ~12,000 beds in total.

## 3. Estimating capacity (stated, per record)

OSM almost never records beds, so every hospital carries `capacitySource`:

| capacitySource | Rule | Hospitals |
|---|---|---|
| `osm:beds` | the `beds` tag | 1 |
| `estimated:footprint` | mapped area ÷ 30 m² per bed (≈ 3–4 storeys at ~100 m² of floor per bed), 40–1,000 | 68 |
| `estimated:point` | mapped only as a point: 40–60 beds, 70–90 with an emergency department | 30 |
| `estimated:major-point` | listed major hospital mapped as a point: 300 | 2 |

ICU ≈ 8 % of beds, ventilators ≈ 60 % of ICU. Starting occupancy is a
deterministic 55–92 % per hospital. The footprint rule is only as good as the
mapping: a campus outline overstates (capped at 1,000), a small outline of a
large hospital understates (Ruby Hall Clinic's mapped outline gives 40).
Migration `0005_data_provenance.sql` stores `osm_id` and `capacity_source`;
the API returns them and the Hospitals page shows how each total was obtained,
with a link to the OSM element.

## 4. Population grid

`tools/real-data/build-population.mjs` turns a GDAL crop of WorldPop's
"Global per-country 2000–2020, 1 km aggregated" grid for India (2020) into a
241 × 241-cell JSON grid (221 KB) that response-service loads. The impact
estimate's `densityAt` reads the grid where it covers the point and falls back
to the zone model elsewhere; every estimate states its `populationSource`.

A 9 km circle over central Pune now holds ~4.85 M people (2011 census, PMC:
3.12 M). The difference is expected: nine years of growth, and a circle is not
the corporation's boundary.

## 5. Tests

| Suite | What |
|---|---|
| `tests/data/snapshots.test.js` (new, in both test runners) | every copy identical to `data/real/`; attribution and date; every hospital a unique OSM element in Pune with consistent capacity and a stated source; the major hospitals present; substations in Pune, nearest first (9) |
| response-service `impact.test.js` | grid loaded and covering Pune, Delhi outside it; 9 km circle in the 2020 range; the zone fallback still gives the census figure |
| real-PostgreSQL suite | seeds the 101 hospitals (provenance columns, migration 0005), trigger, backfill, reservations |
| blood-bank and power `mvn test` | the seeders compile against the snapshot readers |

## 6. Verification (2026-10-25)

| Check | Result |
|---|---|
| Snapshot build | 101 hospitals, 31 substations (two Overpass 502/504 retried) |
| Population build | 241 × 241 cells, 38.7 M people |
| Node tests, real-PostgreSQL suite | pass (57 / 57 DB) |
| Java tests | blood-bank and power green |
| GitHub CI run #23 (push, `3975606`) | 18 / 18 push jobs green, incl. the new data and validation tests |
| GitHub CI run #24 (on demand, `3975606`) | **19 / 19 green**: the end-to-end system check (246 s) seeded the real data into a fresh Compose stack and passed all 15 checks against it |

Data © OpenStreetMap contributors (ODbL 1.0); population © WorldPop (CC BY 4.0).
