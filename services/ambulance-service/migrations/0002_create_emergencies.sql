-- 0002_create_emergencies.sql
-- Emergency incidents this service dispatches ambulances to. This is a
-- lightweight, ambulance-dispatch-scoped notion of "an emergency" —
-- not the full Disaster/Event Intelligence Service (a later phase),
-- which will coordinate across hospitals/blood banks/power as well. An
-- emergency row here answers "where does an ambulance need to go and
-- has one been sent," nothing more.

CREATE TABLE IF NOT EXISTS emergencies (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    description           TEXT NOT NULL,
    latitude              DOUBLE PRECISION NOT NULL,
    longitude             DOUBLE PRECISION NOT NULL,

    severity              VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
    -- ACTIVE: reported, no ambulance assigned yet (e.g. none were
    -- available at creation time). ASSIGNED: an ambulance has been
    -- dispatched and is somewhere in its EN_ROUTE/AT_SCENE/TRANSPORTING
    -- journey. RESOLVED: complete. CANCELLED: reported in error / no
    -- longer needed.
    status                VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',

    assigned_ambulance_id UUID REFERENCES ambulances(id),
    assigned_hospital_id  UUID, -- cross-service reference, no FK (see ambulances table comment)

    created_by_user_id    UUID NOT NULL,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at           TIMESTAMPTZ,

    CONSTRAINT chk_emergency_latitude CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_emergency_longitude CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT chk_emergency_severity CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    CONSTRAINT chk_emergency_status CHECK (status IN ('ACTIVE','ASSIGNED','RESOLVED','CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_emergencies_status ON emergencies(status);
CREATE INDEX IF NOT EXISTS idx_emergencies_assigned_ambulance ON emergencies(assigned_ambulance_id);

DROP TRIGGER IF EXISTS trg_emergencies_updated_at ON emergencies;
CREATE TRIGGER trg_emergencies_updated_at
    BEFORE UPDATE ON emergencies
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at(); -- defined in migration 0001

-- Now that emergencies exists, complete the deferred FK from
-- ambulances.assigned_emergency_id (declared without a constraint in
-- migration 0001, since emergencies didn't exist yet at that point).
ALTER TABLE ambulances
    ADD CONSTRAINT fk_ambulances_assigned_emergency
    FOREIGN KEY (assigned_emergency_id) REFERENCES emergencies(id);
