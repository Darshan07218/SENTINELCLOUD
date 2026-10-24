package com.sentinelcloud.power.entity;

import jakarta.persistence.*;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.time.Instant;
import java.util.UUID;

/**
 * A physical substation site. Transformers (entity/Transformer.java)
 * belong to exactly one substation. Ownership (managedByUserId) lives
 * here, not per-transformer — same "ownership at the parent facility"
 * pattern as hospital-service's hospitals and blood-bank-service's
 * blood banks.
 */
@Entity
@Table(name = "substations")
@EntityListeners(AuditingEntityListener.class)
public class Substation {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(nullable = false, length = 160)
    private String name;

    @Column(nullable = false, columnDefinition = "TEXT")
    private String address;

    @Column(nullable = false)
    private Double latitude;

    @Column(nullable = false)
    private Double longitude;

    /** Free-text grid zone/region label (e.g. "Pune North Grid") — used for coarse grouping on the map/dashboard. */
    @Column(name = "grid_zone", length = 120)
    private String gridZone;

    @Column(name = "managed_by_user_id")
    private UUID managedByUserId;

    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @LastModifiedDate
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Substation() {
        // JPA
    }

    public Substation(String name, String address, Double latitude, Double longitude, String gridZone, UUID managedByUserId) {
        this.name = name;
        this.address = address;
        this.latitude = latitude;
        this.longitude = longitude;
        this.gridZone = gridZone;
        this.managedByUserId = managedByUserId;
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getAddress() { return address; }
    public void setAddress(String address) { this.address = address; }
    public Double getLatitude() { return latitude; }
    public void setLatitude(Double latitude) { this.latitude = latitude; }
    public Double getLongitude() { return longitude; }
    public void setLongitude(Double longitude) { this.longitude = longitude; }
    public String getGridZone() { return gridZone; }
    public void setGridZone(String gridZone) { this.gridZone = gridZone; }
    public UUID getManagedByUserId() { return managedByUserId; }
    public void setManagedByUserId(UUID managedByUserId) { this.managedByUserId = managedByUserId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
