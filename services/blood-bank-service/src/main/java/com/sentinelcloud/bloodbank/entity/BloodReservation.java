package com.sentinelcloud.bloodbank.entity;

import com.sentinelcloud.bloodbank.domain.ReservationStatus;
import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "blood_reservations")
public class BloodReservation {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "batch_id", nullable = false)
    private UUID batchId;

    @Column(name = "hospital_id", nullable = false)
    private UUID hospitalId;

    @Column(name = "units_reserved", nullable = false)
    private Integer unitsReserved;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 16)
    private ReservationStatus status;

    @Column(name = "notes", columnDefinition = "TEXT")
    private String notes;

    @Column(name = "reserved_by_user_id", nullable = false)
    private UUID reservedByUserId;

    @Column(name = "reserved_at", nullable = false)
    private Instant reservedAt;

    @Column(name = "released_at")
    private Instant releasedAt;

    @Column(name = "fulfilled_at")
    private Instant fulfilledAt;

    protected BloodReservation() {
        // JPA
    }

    public BloodReservation(UUID batchId, UUID hospitalId, Integer unitsReserved, String notes, UUID reservedByUserId) {
        this.batchId = batchId;
        this.hospitalId = hospitalId;
        this.unitsReserved = unitsReserved;
        this.notes = notes;
        this.reservedByUserId = reservedByUserId;
        this.status = ReservationStatus.ACTIVE;
        this.reservedAt = Instant.now();
    }

    public void release() {
        this.status = ReservationStatus.RELEASED;
        this.releasedAt = Instant.now();
    }

    public void fulfill() {
        this.status = ReservationStatus.FULFILLED;
        this.fulfilledAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getBatchId() { return batchId; }
    public UUID getHospitalId() { return hospitalId; }
    public Integer getUnitsReserved() { return unitsReserved; }
    public ReservationStatus getStatus() { return status; }
    public String getNotes() { return notes; }
    public UUID getReservedByUserId() { return reservedByUserId; }
    public Instant getReservedAt() { return reservedAt; }
    public Instant getReleasedAt() { return releasedAt; }
    public Instant getFulfilledAt() { return fulfilledAt; }
}
