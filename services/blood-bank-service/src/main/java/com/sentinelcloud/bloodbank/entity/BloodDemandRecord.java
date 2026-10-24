package com.sentinelcloud.bloodbank.entity;

import com.sentinelcloud.bloodbank.domain.BloodGroup;
import com.sentinelcloud.bloodbank.domain.RhFactor;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * One historical demand data point (units requested by hospitals
 * during a period) for a given blood type. Feeds the PROTOTYPE
 * forecasting module — see service/ForecastingService.java for the
 * required disclaimer that this data is demo/synthetic and the model
 * is not medically validated.
 */
@Entity
@Table(name = "blood_demand_records")
public class BloodDemandRecord {

    @Id
    @GeneratedValue
    private UUID id;

    @Enumerated(EnumType.STRING)
    @Column(name = "blood_group", nullable = false, length = 4)
    private BloodGroup bloodGroup;

    @Enumerated(EnumType.STRING)
    @Column(name = "rh_factor", nullable = false, length = 8)
    private RhFactor rhFactor;

    @Column(name = "period_start", nullable = false)
    private LocalDate periodStart;

    @Column(name = "period_end", nullable = false)
    private LocalDate periodEnd;

    @Column(name = "units_requested", nullable = false)
    private Integer unitsRequested;

    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    protected BloodDemandRecord() {
        // JPA
    }

    public BloodDemandRecord(BloodGroup bloodGroup, RhFactor rhFactor, LocalDate periodStart, LocalDate periodEnd, Integer unitsRequested) {
        this.bloodGroup = bloodGroup;
        this.rhFactor = rhFactor;
        this.periodStart = periodStart;
        this.periodEnd = periodEnd;
        this.unitsRequested = unitsRequested;
    }

    public UUID getId() { return id; }
    public BloodGroup getBloodGroup() { return bloodGroup; }
    public RhFactor getRhFactor() { return rhFactor; }
    public LocalDate getPeriodStart() { return periodStart; }
    public LocalDate getPeriodEnd() { return periodEnd; }
    public Integer getUnitsRequested() { return unitsRequested; }
    public Instant getCreatedAt() { return createdAt; }
}
