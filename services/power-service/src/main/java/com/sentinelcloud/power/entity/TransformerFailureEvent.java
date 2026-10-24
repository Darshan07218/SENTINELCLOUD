package com.sentinelcloud.power.entity;

import com.sentinelcloud.power.domain.InfraStatus;
import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * Failure history (one of the required tracked fields). A row is
 * appended every time a transformer's status transitions INTO
 * CRITICAL or FAILED — whether that transition was triggered
 * automatically by a telemetry reading breaching ThresholdEngine's
 * thresholds, or an INFRASTRUCTURE_ADMIN explicitly marking a
 * transformer failed/offline for maintenance. Recovery (a later
 * transition back to NORMAL/WARNING) sets resolvedAt on the most
 * recent open event rather than deleting history — this table is a
 * ledger, never mutated except to close an event out.
 */
@Entity
@Table(name = "transformer_failure_events")
public class TransformerFailureEvent {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(name = "transformer_id", nullable = false)
    private UUID transformerId;

    @Enumerated(EnumType.STRING)
    @Column(name = "previous_status", nullable = false, length = 16)
    private InfraStatus previousStatus;

    @Enumerated(EnumType.STRING)
    @Column(name = "new_status", nullable = false, length = 16)
    private InfraStatus newStatus;

    @Column(nullable = false, columnDefinition = "TEXT")
    private String reason;

    @Column(name = "recorded_by_user_id")
    private UUID recordedByUserId;

    @Column(name = "occurred_at", nullable = false)
    private Instant occurredAt;

    @Column(name = "resolved_at")
    private Instant resolvedAt;

    protected TransformerFailureEvent() {
        // JPA
    }

    public TransformerFailureEvent(UUID transformerId, InfraStatus previousStatus, InfraStatus newStatus, String reason, UUID recordedByUserId) {
        this.transformerId = transformerId;
        this.previousStatus = previousStatus;
        this.newStatus = newStatus;
        this.reason = reason;
        this.recordedByUserId = recordedByUserId;
        this.occurredAt = Instant.now();
    }

    public void resolve() {
        this.resolvedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getTransformerId() { return transformerId; }
    public InfraStatus getPreviousStatus() { return previousStatus; }
    public InfraStatus getNewStatus() { return newStatus; }
    public String getReason() { return reason; }
    public UUID getRecordedByUserId() { return recordedByUserId; }
    public Instant getOccurredAt() { return occurredAt; }
    public Instant getResolvedAt() { return resolvedAt; }
}
