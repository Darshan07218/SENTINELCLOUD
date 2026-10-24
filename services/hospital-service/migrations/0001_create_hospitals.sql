-- 0001_create_hospitals.sql
-- Core Hospital Intelligence Service schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- provides gen_random_uuid()

CREATE TABLE IF NOT EXISTS hospitals (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name                     VARCHAR(160) NOT NULL,
    address                  TEXT NOT NULL,
    latitude                 DOUBLE PRECISION NOT NULL,
    longitude                DOUBLE PRECISION NOT NULL,

    emergency_contact_name   VARCHAR(120) NOT NULL,
    emergency_contact_phone  VARCHAR(32) NOT NULL,

    total_beds               INTEGER NOT NULL,
    available_beds           INTEGER NOT NULL,
    total_icu_beds           INTEGER NOT NULL,
    available_icu_beds       INTEGER NOT NULL,
    total_ventilators        INTEGER NOT NULL,
    available_ventilators    INTEGER NOT NULL,

    -- NORMAL: business as usual. ELEVATED: capacity is tight but
    -- coping. OVERLOADED: explicitly flagged as unable to safely take
    -- more patients (set via POST /hospitals/:id/overload, or cleared
    -- back to NORMAL via the same route). This is distinct from the
    -- *computed* alert logic in services/hospitalService.js — a
    -- hospital can be algorithmically "alert-worthy" (e.g. available
    -- beds below 10%) without a human/operator having explicitly
    -- declared it OVERLOADED, and vice versa.
    emergency_status         VARCHAR(16) NOT NULL DEFAULT 'NORMAL',

    -- Ownership: which HOSPITAL_ADMIN user manages this hospital's
    -- data. No foreign key constraint — auth_db and hospital_db are
    -- separate databases (even separate logical databases within the
    -- same Postgres instance can't have cross-database FKs), so
    -- referential integrity against auth-service's users table is
    -- enforced at the application layer (see middleware/ownership.js)
    -- rather than by Postgres itself. NULL means unclaimed — only a
    -- SYSTEM_ADMIN can currently modify such a hospital, until a
    -- HOSPITAL_ADMIN registers it or is assigned to it.
    managed_by_user_id       UUID,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_latitude CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_longitude CHECK (longitude BETWEEN -180 AND 180),

    CONSTRAINT chk_total_beds_nonneg CHECK (total_beds >= 0),
    CONSTRAINT chk_available_beds_nonneg CHECK (available_beds >= 0),
    CONSTRAINT chk_available_beds_le_total CHECK (available_beds <= total_beds),

    CONSTRAINT chk_total_icu_nonneg CHECK (total_icu_beds >= 0),
    CONSTRAINT chk_available_icu_nonneg CHECK (available_icu_beds >= 0),
    CONSTRAINT chk_available_icu_le_total CHECK (available_icu_beds <= total_icu_beds),

    CONSTRAINT chk_total_vent_nonneg CHECK (total_ventilators >= 0),
    CONSTRAINT chk_available_vent_nonneg CHECK (available_ventilators >= 0),
    CONSTRAINT chk_available_vent_le_total CHECK (available_ventilators <= total_ventilators),

    CONSTRAINT chk_emergency_status CHECK (emergency_status IN ('NORMAL', 'ELEVATED', 'OVERLOADED'))
);

CREATE INDEX IF NOT EXISTS idx_hospitals_emergency_status ON hospitals(emergency_status);
CREATE INDEX IF NOT EXISTS idx_hospitals_available_icu_beds ON hospitals(available_icu_beds);
CREATE INDEX IF NOT EXISTS idx_hospitals_managed_by_user_id ON hospitals(managed_by_user_id);
-- Supports the "near a location" query's coarse bounding-box
-- pre-filter (see repositories/hospitalRepository.js) before the
-- precise Haversine distance is computed in application code.
CREATE INDEX IF NOT EXISTS idx_hospitals_lat_lng ON hospitals(latitude, longitude);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hospitals_updated_at ON hospitals;
CREATE TRIGGER trg_hospitals_updated_at
    BEFORE UPDATE ON hospitals
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
