-- Phase 19: automatic disaster detection (docs/PHASE-19-AUTO-DETECTION.md §2).

-- One row per event a source reported. (source, external_id) is unique, so
-- the same earthquake or forecast polled again is recognised and ignored,
-- also across restarts and replicas.
CREATE TABLE IF NOT EXISTS detections (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source        VARCHAR(16)  NOT NULL,           -- USGS | OPEN_METEO | DEMO
    external_id   VARCHAR(100) NOT NULL,           -- the source's own id
    type          VARCHAR(32)  NOT NULL,           -- a disaster-service type
    severity      VARCHAR(16)  NOT NULL,
    latitude      DOUBLE PRECISION NOT NULL,
    longitude     DOUBLE PRECISION NOT NULL,
    radius_km     DOUBLE PRECISION NOT NULL,
    title         VARCHAR(200) NOT NULL,
    description   TEXT         NOT NULL,
    details       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    observed_at   TIMESTAMPTZ  NOT NULL,           -- when the source says it happened
    detected_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- PENDING: waits for an operator. CONFIRMING: claimed by one confirm while
    -- the disaster is being created (so two clicks can't create two).
    -- CONFIRMED / AUTO_CONFIRMED: a disaster was created (disaster_id).
    -- DISMISSED: an operator said no. EXPIRED: no decision within the expiry
    -- window. FAILED: creating the disaster failed (error); it can be
    -- confirmed again.
    status        VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    disaster_id   UUID,
    decided_by    VARCHAR(200),
    decided_at    TIMESTAMPTZ,
    note          VARCHAR(500),
    error         VARCHAR(500),
    CONSTRAINT uq_detection_source_external UNIQUE (source, external_id),
    CONSTRAINT chk_detection_status CHECK (status IN ('PENDING', 'CONFIRMING', 'CONFIRMED', 'AUTO_CONFIRMED', 'DISMISSED', 'EXPIRED', 'FAILED')),
    CONSTRAINT chk_detection_severity CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))
);

CREATE INDEX IF NOT EXISTS idx_detections_status_time ON detections (status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_detections_time ON detections (detected_at DESC);

-- The last poll of each source, for the page and the readiness of the feeds.
CREATE TABLE IF NOT EXISTS source_status (
    source        VARCHAR(16)  PRIMARY KEY,
    last_polled_at TIMESTAMPTZ,
    last_ok_at    TIMESTAMPTZ,
    last_error    VARCHAR(500),
    last_found    INTEGER      NOT NULL DEFAULT 0,  -- candidates in the last successful poll
    reading       JSONB        NOT NULL DEFAULT '{}'::jsonb -- e.g. rain24hMm / maxGustKmh
);
