package com.sentinelcloud.power.entity;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * One immutable historical telemetry data point (feature 5 — "view
 * historical readings"). Distinct from Transformer's denormalized
 * last* snapshot fields: this table is the append-only ledger every
 * reading is written to; the snapshot is just a fast-read cache of
 * the newest row here. anomalous/anomalyReasons record what
 * AnomalyDetectionService + ThresholdEngine concluded about this
 * specific reading at ingest time, so historical anomalies remain
 * inspectable later even as the transformer's live status moves on.
 */
@Entity
@Table(name = "transformer_readings")
public class TransformerReading {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "transformer_id", nullable = false)
    private UUID transformerId;

    @Column(nullable = false)
    private Double voltage;

    @Column(name = "current_amps", nullable = false)
    private Double currentAmps;

    @Column(name = "load_percentage", nullable = false)
    private Double loadPercentage;

    @Column(name = "temperature_celsius", nullable = false)
    private Double temperatureCelsius;

    @Column(nullable = false)
    private boolean anomalous = false;

    @Column(name = "anomaly_reasons", columnDefinition = "TEXT")
    private String anomalyReasons;

    @Column(name = "recorded_at", nullable = false)
    private Instant recordedAt;

    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    protected TransformerReading() {
        // JPA
    }

    public TransformerReading(UUID transformerId, Double voltage, Double currentAmps, Double loadPercentage,
                               Double temperatureCelsius, boolean anomalous, String anomalyReasons, Instant recordedAt) {
        this.transformerId = transformerId;
        this.voltage = voltage;
        this.currentAmps = currentAmps;
        this.loadPercentage = loadPercentage;
        this.temperatureCelsius = temperatureCelsius;
        this.anomalous = anomalous;
        this.anomalyReasons = anomalyReasons;
        this.recordedAt = recordedAt;
    }

    public UUID getId() { return id; }
    public UUID getTransformerId() { return transformerId; }
    public Double getVoltage() { return voltage; }
    public Double getCurrentAmps() { return currentAmps; }
    public Double getLoadPercentage() { return loadPercentage; }
    public Double getTemperatureCelsius() { return temperatureCelsius; }
    public boolean isAnomalous() { return anomalous; }
    public String getAnomalyReasons() { return anomalyReasons; }
    public Instant getRecordedAt() { return recordedAt; }
    public Instant getCreatedAt() { return createdAt; }
}
