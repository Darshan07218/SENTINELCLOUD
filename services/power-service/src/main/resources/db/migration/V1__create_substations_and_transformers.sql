-- V1__create_substations_and_transformers.sql
-- Core Power Infrastructure Service schema (substations + transformers).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- provides gen_random_uuid()

CREATE TABLE substations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(160) NOT NULL,
    address             TEXT NOT NULL,
    latitude            DOUBLE PRECISION NOT NULL,
    longitude           DOUBLE PRECISION NOT NULL,
    grid_zone           VARCHAR(120),
    -- Ownership, same pattern as hospitals.managed_by_user_id /
    -- blood_banks.managed_by_user_id: which INFRASTRUCTURE_ADMIN (or
    -- SYSTEM_ADMIN) manages this substation's data. No FK — auth_db
    -- is a separate database.
    managed_by_user_id  UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_substation_latitude CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_substation_longitude CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX idx_substations_lat_lng ON substations(latitude, longitude);

-- One row per physical transformer. rated_voltage_kv/rated_current_amps
-- are the nameplate values ThresholdEngine measures percentage
-- deviation against (see service/ThresholdEngine.java). The last_*
-- columns are a denormalized snapshot of the most recent telemetry
-- reading (full history lives in transformer_readings, V2) so
-- overloaded/high-temperature/map queries can filter on simple
-- indexed columns instead of a correlated subquery on every request.
CREATE TABLE transformers (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    substation_id             UUID NOT NULL REFERENCES substations(id) ON DELETE CASCADE,

    code                      VARCHAR(80) NOT NULL,
    name                      VARCHAR(160) NOT NULL,

    rated_voltage_kv          DOUBLE PRECISION NOT NULL,
    rated_current_amps        DOUBLE PRECISION NOT NULL,

    status                    VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
    last_inspection_date      DATE,

    last_voltage              DOUBLE PRECISION,
    last_current_amps         DOUBLE PRECISION,
    last_load_percentage      DOUBLE PRECISION,
    last_temperature_celsius  DOUBLE PRECISION,
    last_reading_at           TIMESTAMPTZ,

    -- Optimistic-locking column backing @Version on the JPA entity —
    -- protects the denormalized snapshot against a lost-update race if
    -- two telemetry submissions for the same transformer ever overlap.
    version                   BIGINT NOT NULL DEFAULT 0,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_transformer_substation_code UNIQUE (substation_id, code),
    CONSTRAINT chk_transformer_status CHECK (status IN ('NORMAL','WARNING','CRITICAL','FAILED')),
    CONSTRAINT chk_rated_voltage_positive CHECK (rated_voltage_kv > 0),
    CONSTRAINT chk_rated_current_positive CHECK (rated_current_amps > 0)
);

CREATE INDEX idx_transformers_substation ON transformers(substation_id);
CREATE INDEX idx_transformers_status ON transformers(status);
CREATE INDEX idx_transformers_last_load ON transformers(last_load_percentage);
CREATE INDEX idx_transformers_last_temp ON transformers(last_temperature_celsius);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_substations_updated_at
    BEFORE UPDATE ON substations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_transformers_updated_at
    BEFORE UPDATE ON transformers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
