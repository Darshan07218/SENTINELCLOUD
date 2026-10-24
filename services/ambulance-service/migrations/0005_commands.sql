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
-- Emergencies created by a dispatch command carry its id, so a retry after
-- a crash halfway through only creates the ones still missing, and a
-- stand-down can find them.
ALTER TABLE emergencies ADD COLUMN IF NOT EXISTS source_command_id UUID;
CREATE INDEX IF NOT EXISTS idx_emergencies_source_command ON emergencies (source_command_id) WHERE source_command_id IS NOT NULL;
