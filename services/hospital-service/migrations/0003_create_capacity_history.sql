-- Phase 18: bed-occupancy history, the input of the capacity forecast
-- (docs/PHASE-18-MAPS-AND-FORECASTS.md §2).
--
-- One row per change of a hospital's bed or ICU numbers. A trigger writes
-- it, so every path that changes capacity (the API, the disaster consumer,
-- the response engine's commands, a manual SQL fix) is recorded in the
-- same transaction as the change, and the application can't forget to.
--
-- source: 'live' for rows the trigger wrote, 'backfill' for the synthetic
-- demo history src/db/seed.js generates for a fresh install, so a forecast
-- can always say how much of its input was real.
CREATE TABLE IF NOT EXISTS hospital_capacity_history (
    id                  BIGSERIAL   PRIMARY KEY,
    hospital_id         UUID        NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    total_beds          INTEGER     NOT NULL,
    available_beds      INTEGER     NOT NULL,
    total_icu_beds      INTEGER     NOT NULL,
    available_icu_beds  INTEGER     NOT NULL,
    source              VARCHAR(16) NOT NULL DEFAULT 'live',
    CONSTRAINT chk_capacity_history_source CHECK (source IN ('live', 'backfill'))
);

CREATE INDEX IF NOT EXISTS idx_capacity_history_hospital_time
    ON hospital_capacity_history (hospital_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION record_hospital_capacity()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT'
       OR NEW.total_beds         IS DISTINCT FROM OLD.total_beds
       OR NEW.available_beds     IS DISTINCT FROM OLD.available_beds
       OR NEW.total_icu_beds     IS DISTINCT FROM OLD.total_icu_beds
       OR NEW.available_icu_beds IS DISTINCT FROM OLD.available_icu_beds THEN
        INSERT INTO hospital_capacity_history
            (hospital_id, total_beds, available_beds, total_icu_beds, available_icu_beds)
        VALUES
            (NEW.id, NEW.total_beds, NEW.available_beds, NEW.total_icu_beds, NEW.available_icu_beds);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hospitals_capacity_history ON hospitals;
CREATE TRIGGER trg_hospitals_capacity_history
    AFTER INSERT OR UPDATE ON hospitals
    FOR EACH ROW
    EXECUTE FUNCTION record_hospital_capacity();

-- Hospitals that existed before this migration start their history now.
INSERT INTO hospital_capacity_history (hospital_id, total_beds, available_beds, total_icu_beds, available_icu_beds)
SELECT h.id, h.total_beds, h.available_beds, h.total_icu_beds, h.available_icu_beds
  FROM hospitals h
 WHERE NOT EXISTS (SELECT 1 FROM hospital_capacity_history c WHERE c.hospital_id = h.id);
