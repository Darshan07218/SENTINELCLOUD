package com.sentinelcloud.bloodbank.entity;

import com.sentinelcloud.bloodbank.domain.BloodGroup;
import com.sentinelcloud.bloodbank.domain.RhFactor;
import jakarta.persistence.*;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

@Entity
@Table(name = "blood_inventory_batches")
@EntityListeners(AuditingEntityListener.class)
public class BloodInventoryBatch {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "blood_bank_id", nullable = false)
    private UUID bloodBankId;

    @Enumerated(EnumType.STRING)
    @Column(name = "blood_group", nullable = false, length = 4)
    private BloodGroup bloodGroup;

    @Enumerated(EnumType.STRING)
    @Column(name = "rh_factor", nullable = false, length = 8)
    private RhFactor rhFactor;

    @Column(name = "units_available", nullable = false)
    private Integer unitsAvailable;

    @Column(name = "reserved_units", nullable = false)
    private Integer reservedUnits = 0;

    @Column(name = "collection_date", nullable = false)
    private LocalDate collectionDate;

    @Column(name = "expiry_date", nullable = false)
    private LocalDate expiryDate;

    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @LastModifiedDate
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    // Optimistic locking: reservations decrement units_available on
    // this same row concurrently from potentially multiple requests —
    // @Version makes a lost-update race throw
    // OptimisticLockException instead of silently overwriting another
    // request's change, which ReservationService retries on (see
    // service/ReservationService.java).
    @Version
    @Column(name = "version", nullable = false)
    private Long version = 0L;

    protected BloodInventoryBatch() {
        // JPA
    }

    public BloodInventoryBatch(UUID bloodBankId, BloodGroup bloodGroup, RhFactor rhFactor,
                                Integer unitsAvailable, LocalDate collectionDate, LocalDate expiryDate) {
        this.bloodBankId = bloodBankId;
        this.bloodGroup = bloodGroup;
        this.rhFactor = rhFactor;
        this.unitsAvailable = unitsAvailable;
        this.collectionDate = collectionDate;
        this.expiryDate = expiryDate;
        this.reservedUnits = 0;
    }

    /** A batch is expired once "today" (asOf) is on or after its expiry date. */
    public boolean isExpired(LocalDate asOf) {
        return !asOf.isBefore(expiryDate);
    }

    public UUID getId() { return id; }
    public UUID getBloodBankId() { return bloodBankId; }
    public BloodGroup getBloodGroup() { return bloodGroup; }
    public RhFactor getRhFactor() { return rhFactor; }
    public Integer getUnitsAvailable() { return unitsAvailable; }
    public void setUnitsAvailable(Integer unitsAvailable) { this.unitsAvailable = unitsAvailable; }
    public Integer getReservedUnits() { return reservedUnits; }
    public void setReservedUnits(Integer reservedUnits) { this.reservedUnits = reservedUnits; }
    public LocalDate getCollectionDate() { return collectionDate; }
    public void setCollectionDate(LocalDate collectionDate) { this.collectionDate = collectionDate; }
    public LocalDate getExpiryDate() { return expiryDate; }
    public void setExpiryDate(LocalDate expiryDate) { this.expiryDate = expiryDate; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public Long getVersion() { return version; }
}
