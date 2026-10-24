-- 0001_create_disasters.sql
-- Core Disaster/Event Intelligence Service schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- provides gen_random_uuid()

CREATE TABLE IF NOT EXISTS disasters (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    type              VARCHAR(32) NOT NULL,
    severity          VARCHAR(16) NOT NULL,

    -- Epicenter + affected-zone radius. Every reacting service (Hospital,
    -- Ambulance, Blood Bank, Power) runs its own "near this point, within
    -- this radius" query using these two fields — see
    -- src/services/disasterService.js publishDetected().
    latitude          DOUBLE PRECISION NOT NULL,
    longitude         DOUBLE PRECISION NOT NULL,
    radius_km         DOUBLE PRECISION NOT NULL,

    description       TEXT NOT NULL,
    status            VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',

    created_by_user_id UUID,

    -- occurred_at is when the disaster itself started (can be backdated
    -- if entered slightly after the fact); created_at is when this row
    -- was inserted. They're usually seconds apart in a live demo but are
    -- semantically distinct.
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_disaster_type CHECK (type IN ('FLOOD','FIRE','EARTHQUAKE','CYCLONE','LANDSLIDE','INDUSTRIAL_ACCIDENT')),
    CONSTRAINT chk_disaster_severity CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    CONSTRAINT chk_disaster_status CHECK (status IN ('ACTIVE','CONTAINED','RESOLVED')),
    CONSTRAINT chk_disaster_latitude CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_disaster_longitude CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT chk_disaster_radius_positive CHECK (radius_km > 0)
);

CREATE INDEX IF NOT EXISTS idx_disasters_status ON disasters(status);
CREATE INDEX IF NOT EXISTS idx_disasters_type ON disasters(type);
CREATE INDEX IF NOT EXISTS idx_disasters_lat_lng ON disasters(latitude, longitude);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_disasters_updated_at ON disasters;
CREATE TRIGGER trg_disasters_updated_at
    BEFORE UPDATE ON disasters
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
