-- Phase 21: where a hospital's data came from (docs/PHASE-21-REAL-DATA.md).
--
-- osm_id: the OpenStreetMap element the location and name come from
--         (e.g. "way/218059566"); NULL for hospitals registered through the API.
-- capacity_source: how the bed/ICU/ventilator totals were obtained:
--         osm:beds | estimated:footprint | estimated:point | estimated:major-point,
--         or NULL when a person entered them (API).
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS osm_id VARCHAR(40);
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS capacity_source VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hospitals_osm_id ON hospitals (osm_id) WHERE osm_id IS NOT NULL;
