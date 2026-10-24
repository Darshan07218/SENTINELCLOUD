-- Phase 14: transactional outbox (docs/PHASE-14-RELIABLE-EVENTS.md §2.1).
--
-- An event is INSERTed here in the same transaction as the change it
-- describes, so both are saved or neither is. src/outbox.js sends unsent rows
-- to RabbitMQ (publisher confirms) and sets published_at; rows published more
-- than 7 days ago are deleted by the same relay.
CREATE TABLE IF NOT EXISTS outbox (
    id            BIGSERIAL   PRIMARY KEY,           -- send order
    event_id      UUID        NOT NULL UNIQUE,       -- the envelope's eventId / AMQP messageId
    routing_key   TEXT        NOT NULL,
    envelope      JSONB       NOT NULL,              -- the full envelope, built at write time
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ,                       -- NULL = not yet confirmed by RabbitMQ
    attempts      INT         NOT NULL DEFAULT 0,
    last_error    TEXT
);
-- The relay's only query: unsent rows, oldest first. Stays tiny because
-- published rows drop out of it.
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
