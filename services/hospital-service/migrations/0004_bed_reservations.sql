-- Phase 20: bed reservations for response plans (docs/PHASE-20-SMARTER-RESPONSE.md §2).

-- Commands from response-service are executed once each: one row per
-- command id with the reply that was sent (same table as ambulance-service,
-- disaster-service and blood-bank-service; see src/commands.js).
CREATE TABLE IF NOT EXISTS processed_commands (
    command_id    UUID        PRIMARY KEY,
    command       TEXT        NOT NULL,   -- routing key, e.g. command.hospital.reserve-beds
    outcome       TEXT        NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    result        JSONB,
    processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A reservation takes beds off the hospital's free count at once (so a second
-- disaster can't count on them) and gives them back when released (plan
-- undone, or by the hospital). Releasing never lifts free beds above the total.
CREATE TABLE IF NOT EXISTS bed_reservations (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id        UUID        NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
    beds               INTEGER     NOT NULL CHECK (beds >= 0),
    icu_beds           INTEGER     NOT NULL CHECK (icu_beds >= 0),
    disaster_id        UUID,
    plan_id            UUID,
    -- The command that created it: a retried command finds it instead of
    -- holding the beds a second time.
    source_command_id  UUID        UNIQUE,
    notes              VARCHAR(300),
    status             VARCHAR(16) NOT NULL DEFAULT 'HELD',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at        TIMESTAMPTZ,
    CONSTRAINT chk_bed_reservation_status CHECK (status IN ('HELD', 'RELEASED')),
    CONSTRAINT chk_bed_reservation_nonempty CHECK (beds + icu_beds > 0)
);

CREATE INDEX IF NOT EXISTS idx_bed_reservations_hospital_held ON bed_reservations (hospital_id) WHERE status = 'HELD';
