-- V2__create_transformer_readings.sql
-- Append-only telemetry ledger (feature 5 — view historical readings).
-- Every POST /transformers/{id}/telemetry call inserts exactly one row
-- here; transformers.last_* columns are just a fast-read cache of the
-- newest row for this transformer_id. anomalous/anomaly_reasons record
-- what AnomalyDetectionService + ThresholdEngine concluded about this
-- specific reading at ingest time (see service/TelemetryService.java),
-- so a past anomaly stays inspectable even after the transformer's
-- live status has since moved on.

CREATE TABLE transformer_readings (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transformer_id       UUID NOT NULL REFERENCES transformers(id) ON DELETE CASCADE,

    voltage              DOUBLE PRECISION NOT NULL,
    current_amps         DOUBLE PRECISION NOT NULL,
    load_percentage      DOUBLE PRECISION NOT NULL,
    temperature_celsius  DOUBLE PRECISION NOT NULL,

    anomalous            BOOLEAN NOT NULL DEFAULT FALSE,
    anomaly_reasons      TEXT,

    recorded_at          TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_reading_voltage_nonneg CHECK (voltage >= 0),
    CONSTRAINT chk_reading_current_nonneg CHECK (current_amps >= 0),
    CONSTRAINT chk_reading_load_nonneg CHECK (load_percentage >= 0)
);

-- Descending index on (transformer_id, recorded_at) — every hot-path
-- query (latest snapshot, baseline window, paged history) reads most
-- recent first for a single transformer_id.
CREATE INDEX idx_readings_transformer_recorded_desc ON transformer_readings(transformer_id, recorded_at DESC);
CREATE INDEX idx_readings_anomalous ON transformer_readings(anomalous) WHERE anomalous = TRUE;
