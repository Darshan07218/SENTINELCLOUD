-- Phase 15: response-service schema (docs/PHASE-15-RESPONSE-ENGINE.md §4).

-- This service's own picture of each disaster, built only from events
-- (disaster.* and the four reactions), like the situation report.
CREATE TABLE IF NOT EXISTS disaster_context (
    disaster_id   UUID        PRIMARY KEY,
    disaster      JSONB       NOT NULL,              -- latest disaster.* payload
    status        TEXT        NOT NULL,              -- ACTIVE | CONTAINED | RESOLVED
    radius_km     DOUBLE PRECISION NOT NULL,         -- current search radius
    -- { "<reaction routing key>": { "payload": {…}, "occurredAt": "…" } }
    reactions     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One plan per disaster and revision (2 = the follow-up after an escalation).
CREATE TABLE IF NOT EXISTS response_plans (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    disaster_id       UUID        NOT NULL REFERENCES disaster_context(disaster_id),
    revision          INT         NOT NULL CHECK (revision IN (1, 2)),
    status            TEXT        NOT NULL CHECK (status IN
                        ('PROPOSED','EXECUTING','COMPLETED','PARTIAL','REJECTED','EXPIRED','UNDOING','ROLLED_BACK')),
    mode              TEXT        NOT NULL CHECK (mode IN ('APPROVAL','AUTO')),
    needs             JSONB       NOT NULL,          -- what the playbook said this disaster needs
    disaster          JSONB       NOT NULL,          -- the disaster as planned against
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by        UUID,                          -- approver / rejecter (NULL for AUTO)
    decided_at        TIMESTAMPTZ,
    decision_note     TEXT,
    finished_at       TIMESTAMPTZ,
    undone_by         UUID,
    undone_at         TIMESTAMPTZ,
    UNIQUE (disaster_id, revision)                   -- two replicas can't plan the same thing twice
);
CREATE INDEX IF NOT EXISTS idx_response_plans_status ON response_plans (status, created_at DESC);

CREATE TABLE IF NOT EXISTS response_actions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id         UUID        NOT NULL REFERENCES response_plans(id),
    seq             INT         NOT NULL,
    kind            TEXT        NOT NULL,            -- ambulance.dispatch | blood.reserve | disaster.widen_radius | notice
    params          JSONB       NOT NULL,
    reason          TEXT        NOT NULL,
    status          TEXT        NOT NULL CHECK (status IN
                      ('PROPOSED','INFO','PENDING','SUCCEEDED','FAILED','SKIPPED','UNDOING','UNDONE','UNDO_FAILED')),
    command_id      UUID        UNIQUE,              -- the command that executes it
    undo_command_id UUID        UNIQUE,              -- the command that reverses it
    result          JSONB,
    error           JSONB,
    sent_at         TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    UNIQUE (plan_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_response_actions_pending ON response_actions (sent_at) WHERE status IN ('PENDING','UNDOING');
