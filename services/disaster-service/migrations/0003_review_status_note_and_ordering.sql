-- 0003_review_status_note_and_ordering.sql (engineering review)
--
-- 1. disasters.status_note: POST /disasters/:id/status accepted a `note`
--    ("why was this contained/resolved?") but silently discarded it.
-- 2. disaster_reactions.event_occurred_at: the publisher's occurredAt.
--    RabbitMQ does not guarantee order across redeliveries, so an older
--    reaction arriving late used to overwrite a newer one; the upsert now
--    only replaces a row with an event that is at least as new.
-- 3. (status, occurred_at DESC): serves GET /disasters?status=… and
--    GET /disasters/active, which filter by status and sort by time.
ALTER TABLE disasters ADD COLUMN IF NOT EXISTS status_note TEXT;
ALTER TABLE disaster_reactions ADD COLUMN IF NOT EXISTS event_occurred_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_disasters_status_occurred ON disasters(status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_disasters_occurred ON disasters(occurred_at DESC);
