package com.sentinelcloud.power.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public class MiscDtos {

    public enum AlertSeverity { WARNING, CRITICAL, FAILED }

    /**
     * Feature 4 — one aggregated infrastructure alert. type is one of
     * OVERLOADED, HIGH_TEMPERATURE, VOLTAGE_ANOMALY, CURRENT_ANOMALY,
     * STATISTICAL_ANOMALY, TRANSFORMER_FAILED, INSPECTION_OVERDUE —
     * see service/AlertService.java.
     */
    public record InfrastructureAlert(
        AlertSeverity severity, String type, UUID substationId, String substationName,
        UUID transformerId, String transformerCode, String message, Instant occurredAt
    ) {}

    /** Feature 3 — result of checking one transformer's latest reading for abnormalities (rule-based + statistical). */
    public record AnomalyReport(
        UUID transformerId, String transformerCode, boolean abnormal,
        List<String> ruleBasedFindings, List<String> statisticalFindings
    ) {}

    /** Feature 8 — one map marker: a substation plus the worst status among its transformers, for map pin coloring. */
    public record MapMarker(
        UUID substationId, String substationName, Double latitude, Double longitude, String gridZone,
        String worstStatus, int transformerCount, List<TransformerMapPoint> transformers
    ) {}

    public record TransformerMapPoint(UUID transformerId, String code, String status, Double loadPercentage, Double temperatureCelsius) {}
}
