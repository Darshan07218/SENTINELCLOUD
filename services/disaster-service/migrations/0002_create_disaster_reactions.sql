-- 0002_create_disaster_reactions.sql
-- Fan-in side of the event-driven flow: every reaction event
-- (hospital.capacity.updated, ambulance.status.updated,
-- blood.shortage.detected, power.infrastructure.at_risk) consumed by
-- q.disaster.reaction-aggregator is stored here, keyed by the
-- disaster's id as correlationId. GET /disasters/:id/situation-report
-- reads this table to answer "what has each service reported back for
-- this disaster so far" without any synchronous call to those
-- services — this IS the fan-in half of the publish/fan-out/fan-in
-- pattern documented in docs/ARCHITECTURE.md section 4.3.

CREATE TABLE IF NOT EXISTS disaster_reactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    disaster_id     UUID NOT NULL REFERENCES disasters(id) ON DELETE CASCADE,

    -- Matches ROUTING_KEYS in src/events/eventTypes.js, e.g.
    -- "hospital.capacity.updated".
    event_type      VARCHAR(64) NOT NULL,
    source_service  VARCHAR(64) NOT NULL,
    event_id        UUID NOT NULL,

    payload         JSONB NOT NULL,

    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The same reacting service publishing twice for one disaster (a
    -- correction, or the consumer redelivering after a transient
    -- failure) replaces its prior entry rather than accumulating
    -- duplicates — the situation report should show each service's
    -- LATEST reaction, not a growing log of every attempt.
    CONSTRAINT uq_disaster_reaction_source UNIQUE (disaster_id, event_type, source_service)
);

CREATE INDEX IF NOT EXISTS idx_disaster_reactions_disaster ON disaster_reactions(disaster_id);
