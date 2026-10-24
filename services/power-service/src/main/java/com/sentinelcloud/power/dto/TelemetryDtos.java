package com.sentinelcloud.power.dto;

import com.sentinelcloud.power.entity.TransformerReading;

import java.time.Instant;
import java.util.UUID;

public class TelemetryDtos {

    public record ReadingResponse(
        UUID id, UUID transformerId, Double voltage, Double currentAmps, Double loadPercentage,
        Double temperatureCelsius, boolean anomalous, String anomalyReasons, Instant recordedAt
    ) {
        public static ReadingResponse of(TransformerReading r) {
            return new ReadingResponse(r.getId(), r.getTransformerId(), r.getVoltage(), r.getCurrentAmps(),
                r.getLoadPercentage(), r.getTemperatureCelsius(), r.isAnomalous(), r.getAnomalyReasons(), r.getRecordedAt());
        }
    }

    /** What TelemetryService.recordTelemetry() hands back — the stored reading plus the transformer's resulting state. */
    public record TelemetryResult(
        ReadingResponse reading, String status, boolean statusChanged, boolean anomalyDetected, java.util.List<String> anomalyReasons
    ) {}

    public record FailureEventResponse(
        UUID id, UUID transformerId, String previousStatus, String newStatus, String reason,
        UUID recordedByUserId, Instant occurredAt, Instant resolvedAt
    ) {
        public static FailureEventResponse of(com.sentinelcloud.power.entity.TransformerFailureEvent e) {
            return new FailureEventResponse(e.getId(), e.getTransformerId(), e.getPreviousStatus().name(),
                e.getNewStatus().name(), e.getReason(), e.getRecordedByUserId(), e.getOccurredAt(), e.getResolvedAt());
        }
    }
}
