-- V3__create_transformer_failure_events.sql
-- Failure history (one of the required tracked fields). A row is
-- appended every time a transformer's status transitions INTO
-- CRITICAL or FAILED (automatically, from a telemetry threshold
-- breach, or manually via POST /transformers/{id}/status). Recovery
-- back to NORMAL/WARNING resolves the most recent open event by
-- setting resolved_at, rather than deleting the row — this table is
-- an append-only ledger, same philosophy as transformer_readings.

CREATE TABLE transformer_failure_events (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transformer_id       UUID NOT NULL REFERENCES transformers(id) ON DELETE CASCADE,

    previous_status      VARCHAR(16) NOT NULL,
    new_status           VARCHAR(16) NOT NULL,
    reason               TEXT NOT NULL,
    recorded_by_user_id  UUID,

    occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at          TIMESTAMPTZ,

    CONSTRAINT chk_failure_previous_status CHECK (previous_status IN ('NORMAL','WARNING','CRITICAL','FAILED')),
    CONSTRAINT chk_failure_new_status CHECK (new_status IN ('NORMAL','WARNING','CRITICAL','FAILED'))
);

CREATE INDEX idx_failure_events_transformer ON transformer_failure_events(transformer_id);
CREATE INDEX idx_failure_events_open ON transformer_failure_events(transformer_id) WHERE resolved_at IS NULL;
