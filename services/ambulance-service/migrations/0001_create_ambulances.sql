-- 0001_create_ambulances.sql
-- Core Ambulance & Emergency Response Service schema (ambulance half).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- provides gen_random_uuid()

CREATE TABLE IF NOT EXISTS ambulances (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    vehicle_number          VARCHAR(32) NOT NULL UNIQUE,

    latitude                DOUBLE PRECISION NOT NULL,
    longitude               DOUBLE PRECISION NOT NULL,

    -- AVAILABLE -> DISPATCHED -> EN_ROUTE -> AT_SCENE -> TRANSPORTING ->
    -- AT_HOSPITAL -> AVAILABLE is the normal happy path; OUT_OF_SERVICE
    -- is reachable from (almost) anywhere and must return to AVAILABLE
    -- before being dispatched again. The exact legal-transition graph
    -- lives in application code (services/statusMachine.js) rather than
    -- as a DB constraint, since expressing a full state machine in SQL
    -- CHECK constraints is unreadable — the CHECK here only guards
    -- against a value outside the known set entirely.
    status                  VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',

    driver_name             VARCHAR(120) NOT NULL,
    driver_phone            VARCHAR(32) NOT NULL,

    -- BASIC: first aid + oxygen. ADVANCED: paramedic-staffed, cardiac
    -- monitor, IV. CRITICAL_CARE: ICU-equivalent in-transit (ventilator,
    -- infusion pumps, critical-care-trained crew).
    equipment_level         VARCHAR(20) NOT NULL DEFAULT 'BASIC',

    -- Cross-service references (hospital-service), and a same-database
    -- reference to this service's own emergencies table. No FK to
    -- hospitals — separate database, see the identical rationale in
    -- hospital-service's managed_by_user_id column comment.
    --
    -- assigned_emergency_id has NO FK constraint declared here on
    -- purpose: emergencies is created in migration 0002, which comes
    -- after this file, and Postgres can't forward-reference a table
    -- that doesn't exist yet. Migration 0002 adds the FK via
    -- ALTER TABLE once both tables exist — see the comment there.
    assigned_hospital_id    UUID,
    assigned_emergency_id   UUID,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_ambulance_latitude CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_ambulance_longitude CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT chk_ambulance_status CHECK (
        status IN ('AVAILABLE','DISPATCHED','EN_ROUTE','AT_SCENE','TRANSPORTING','AT_HOSPITAL','OUT_OF_SERVICE')
    ),
    CONSTRAINT chk_ambulance_equipment_level CHECK (
        equipment_level IN ('BASIC','ADVANCED','CRITICAL_CARE')
    )
);

CREATE INDEX IF NOT EXISTS idx_ambulances_status ON ambulances(status);
CREATE INDEX IF NOT EXISTS idx_ambulances_lat_lng ON ambulances(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_ambulances_assigned_emergency ON ambulances(assigned_emergency_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ambulances_updated_at ON ambulances;
CREATE TRIGGER trg_ambulances_updated_at
    BEFORE UPDATE ON ambulances
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
