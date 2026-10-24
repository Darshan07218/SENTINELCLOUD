-- V1__create_blood_banks_and_inventory.sql
-- Core Blood Bank Intelligence Service schema (blood banks + batch-level inventory).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- provides gen_random_uuid()

CREATE TABLE blood_banks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(160) NOT NULL,
    address             TEXT NOT NULL,
    latitude            DOUBLE PRECISION NOT NULL,
    longitude           DOUBLE PRECISION NOT NULL,
    contact_phone       VARCHAR(32) NOT NULL,
    -- Ownership, same pattern as hospitals.managed_by_user_id in
    -- hospital-service: which HOSPITAL_ADMIN (or SYSTEM_ADMIN) manages
    -- this blood bank's data. No FK — auth_db is a separate database.
    managed_by_user_id  UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_blood_bank_latitude CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_blood_bank_longitude CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX idx_blood_banks_lat_lng ON blood_banks(latitude, longitude);

-- Inventory is tracked at the BATCH level (one row per donation lot per
-- blood bank per blood group/Rh combination), not as one aggregated
-- row per blood type. This is the realistic model real blood banks
-- use for traceability and FEFO (first-expiry-first-out) issuing —
-- it's also exactly what lets this service track collection date and
-- expiry date per the requirements, rather than a single fuzzy
-- "expiry" for a whole blood type's total stock.
CREATE TABLE blood_inventory_batches (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blood_bank_id     UUID NOT NULL REFERENCES blood_banks(id) ON DELETE CASCADE,

    -- blood_group (A/B/AB/O) + rh_factor (POSITIVE/NEGATIVE) together
    -- express the 8 supported types (A+, A-, B+, B-, AB+, AB-, O+, O-)
    -- as two normalized columns rather than one free-text "A+" string
    -- — this lets queries group by ABO type alone when useful (e.g.
    -- "total A blood regardless of Rh") while the combination still
    -- fully covers the 8 required types.
    blood_group       VARCHAR(4) NOT NULL,
    rh_factor         VARCHAR(8) NOT NULL,

    units_available   INTEGER NOT NULL,
    reserved_units    INTEGER NOT NULL DEFAULT 0,

    collection_date   DATE NOT NULL,
    expiry_date       DATE NOT NULL,

    -- Optimistic-locking column backing @Version on the JPA entity
    -- (BloodInventoryBatch) — protects concurrent reservation requests
    -- against a lost-update race on units_available.
    version           BIGINT NOT NULL DEFAULT 0,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_blood_group CHECK (blood_group IN ('A','B','AB','O')),
    CONSTRAINT chk_rh_factor CHECK (rh_factor IN ('POSITIVE','NEGATIVE')),
    CONSTRAINT chk_units_available_nonneg CHECK (units_available >= 0),
    CONSTRAINT chk_reserved_units_nonneg CHECK (reserved_units >= 0),
    CONSTRAINT chk_expiry_after_collection CHECK (expiry_date > collection_date)
);

CREATE INDEX idx_batches_blood_bank ON blood_inventory_batches(blood_bank_id);
CREATE INDEX idx_batches_group_rh ON blood_inventory_batches(blood_group, rh_factor);
CREATE INDEX idx_batches_expiry_date ON blood_inventory_batches(expiry_date);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_blood_banks_updated_at
    BEFORE UPDATE ON blood_banks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_batches_updated_at
    BEFORE UPDATE ON blood_inventory_batches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
