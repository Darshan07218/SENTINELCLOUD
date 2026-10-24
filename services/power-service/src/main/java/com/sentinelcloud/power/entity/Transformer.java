package com.sentinelcloud.power.entity;

import com.sentinelcloud.power.domain.InfraStatus;
import jakarta.persistence.*;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * One transformer, owned by exactly one substation. Rated
 * voltage/current are the transformer's nameplate values — the
 * reference point ThresholdEngine measures percentage deviation
 * against, since "230V" means something different for a distribution
 * transformer than for a step-up transformer at a generating station.
 *
 * The last* fields are a denormalized snapshot of this transformer's
 * most recent telemetry reading, updated every time
 * TelemetryService.recordTelemetry() runs — the same "latest state +
 * full history in a separate table" pattern blood-bank-service uses
 * for units_available (batch row) vs. the immutable ledger a real
 * system would keep. This lets overloaded/high-temperature/map
 * queries filter on simple indexed columns instead of a correlated
 * subquery against transformer_readings on every request.
 */
@Entity
@Table(name = "transformers")
@EntityListeners(AuditingEntityListener.class)
public class Transformer {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "substation_id", nullable = false)
    private UUID substationId;

    @Column(nullable = false, length = 80)
    private String code;

    @Column(nullable = false, length = 160)
    private String name;

    @Column(name = "rated_voltage_kv", nullable = false)
    private Double ratedVoltageKv;

    @Column(name = "rated_current_amps", nullable = false)
    private Double ratedCurrentAmps;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private InfraStatus status = InfraStatus.NORMAL;

    @Column(name = "last_inspection_date")
    private LocalDate lastInspectionDate;

    // ---- denormalized latest-reading snapshot (nullable until the first telemetry update) ----
    @Column(name = "last_voltage")
    private Double lastVoltage;

    @Column(name = "last_current_amps")
    private Double lastCurrentAmps;

    @Column(name = "last_load_percentage")
    private Double lastLoadPercentage;

    @Column(name = "last_temperature_celsius")
    private Double lastTemperatureCelsius;

    @Column(name = "last_reading_at")
    private Instant lastReadingAt;

    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @LastModifiedDate
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    @Column(nullable = false)
    private Long version = 0L;

    protected Transformer() {
        // JPA
    }

    public Transformer(UUID substationId, String code, String name, Double ratedVoltageKv, Double ratedCurrentAmps, LocalDate lastInspectionDate) {
        this.substationId = substationId;
        this.code = code;
        this.name = name;
        this.ratedVoltageKv = ratedVoltageKv;
        this.ratedCurrentAmps = ratedCurrentAmps;
        this.lastInspectionDate = lastInspectionDate;
        this.status = InfraStatus.NORMAL;
    }

    public void applyTelemetrySnapshot(double voltage, double currentAmps, double loadPercentage, double temperatureCelsius,
                                        Instant recordedAt, InfraStatus newStatus) {
        this.lastVoltage = voltage;
        this.lastCurrentAmps = currentAmps;
        this.lastLoadPercentage = loadPercentage;
        this.lastTemperatureCelsius = temperatureCelsius;
        this.lastReadingAt = recordedAt;
        this.status = newStatus;
    }

    public UUID getId() { return id; }
    public UUID getSubstationId() { return substationId; }
    public String getCode() { return code; }
    public void setCode(String code) { this.code = code; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public Double getRatedVoltageKv() { return ratedVoltageKv; }
    public void setRatedVoltageKv(Double ratedVoltageKv) { this.ratedVoltageKv = ratedVoltageKv; }
    public Double getRatedCurrentAmps() { return ratedCurrentAmps; }
    public void setRatedCurrentAmps(Double ratedCurrentAmps) { this.ratedCurrentAmps = ratedCurrentAmps; }
    public InfraStatus getStatus() { return status; }
    public void setStatus(InfraStatus status) { this.status = status; }
    public LocalDate getLastInspectionDate() { return lastInspectionDate; }
    public void setLastInspectionDate(LocalDate lastInspectionDate) { this.lastInspectionDate = lastInspectionDate; }
    public Double getLastVoltage() { return lastVoltage; }
    public Double getLastCurrentAmps() { return lastCurrentAmps; }
    public Double getLastLoadPercentage() { return lastLoadPercentage; }
    public Double getLastTemperatureCelsius() { return lastTemperatureCelsius; }
    public Instant getLastReadingAt() { return lastReadingAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public Long getVersion() { return version; }
}
