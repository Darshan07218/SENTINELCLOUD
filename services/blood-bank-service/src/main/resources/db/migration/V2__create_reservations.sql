-- V2__create_reservations.sql
-- A reservation always draws from exactly one batch (the earliest-
-- expiring batch with enough available units — FEFO selection, see
-- service/ReservationService.java). If no single batch has enough
-- units, the request is rejected rather than silently split across
-- multiple batches — a deliberate scope simplification documented in
-- docs/PHASE-5-BLOOD-BANK.md, trading a small amount of allocation
-- flexibility for a materially simpler, more auditable data model (one
-- reservation <-> one batch, no allocation join table).

CREATE TABLE blood_reservations (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id             UUID NOT NULL REFERENCES blood_inventory_batches(id),
    -- Cross-service reference to hospital-service's hospitals table.
    -- No FK (separate database) — same rationale as every other
    -- cross-service reference in this project.
    hospital_id          UUID NOT NULL,
    units_reserved       INTEGER NOT NULL,
    status               VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    notes                TEXT,
    reserved_by_user_id  UUID NOT NULL,
    reserved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at          TIMESTAMPTZ,
    fulfilled_at         TIMESTAMPTZ,

    CONSTRAINT chk_units_reserved_positive CHECK (units_reserved > 0),
    CONSTRAINT chk_reservation_status CHECK (status IN ('ACTIVE','RELEASED','FULFILLED'))
);

CREATE INDEX idx_reservations_batch ON blood_reservations(batch_id);
CREATE INDEX idx_reservations_hospital ON blood_reservations(hospital_id);
CREATE INDEX idx_reservations_status ON blood_reservations(status);
