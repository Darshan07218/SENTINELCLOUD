# Real-data snapshots

Built by `tools/real-data/` (see `docs/PHASE-21-REAL-DATA.md`). Each service
that seeds from a file has an identical copy; `tests/data/snapshots.test.js`
checks they match.

| File | Source | License |
|---|---|---|
| `pune-hospitals.json` | OpenStreetMap, via the Overpass API | ODbL 1.0, © OpenStreetMap contributors |
| `pune-substations.json` | OpenStreetMap, via the Overpass API | ODbL 1.0, © OpenStreetMap contributors |
| `pune-population-worldpop-2020-1km.json` | WorldPop, Global per-country 2000–2020, 1 km aggregated, India 2020 | CC BY 4.0; WorldPop and CIESIN, Columbia University (2018), doi:10.5258/SOTON/WP00671 |

Bed, ICU and ventilator counts in `pune-hospitals.json` are **estimates**
unless `capacitySource` is `osm:beds`; each record says which.
