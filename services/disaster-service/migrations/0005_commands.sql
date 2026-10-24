-- Phase 15: executing commands from response-service exactly once
-- (docs/PHASE-15-RESPONSE-ENGINE.md §3). One row per command id, with the
-- reply that was sent, so a redelivered command replays its reply instead
-- of running again.
CREATE TABLE IF NOT EXISTS processed_commands (
    command_id    UUID        PRIMARY KEY,
    command       TEXT        NOT NULL,   -- routing key, e.g. command.ambulance.dispatch
    outcome       TEXT        NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    result        JSONB,
    processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
