package com.sentinelcloud.power.controller;

import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.dto.MiscDtos.*;
import com.sentinelcloud.power.dto.TransformerDtos.TransformerResponse;
import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.service.AlertService;
import com.sentinelcloud.power.service.SubstationService;
import com.sentinelcloud.power.service.TelemetryService;
import com.sentinelcloud.power.service.ThresholdEngine;
import com.sentinelcloud.power.service.TransformerService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Cross-cutting read endpoints: feature 4 (alerts), feature 6
 * (overloaded), feature 7 (high-temperature), feature 8 (map), plus a
 * dashboard summary — same pattern as blood-bank-service's
 * AnalyticsController.
 */
@RestController
public class AnalyticsController {

    private final SubstationService substationService;
    private final TransformerService transformerService;
    private final TelemetryService telemetryService;
    private final AlertService alertService;

    public AnalyticsController(SubstationService substationService, TransformerService transformerService,
                                TelemetryService telemetryService, AlertService alertService) {
        this.substationService = substationService;
        this.transformerService = transformerService;
        this.telemetryService = telemetryService;
        this.alertService = alertService;
    }

    /** Feature 6 — identify overloaded transformers (last load% at or above the warning band). */
    @GetMapping("/transformers/overloaded")
    public Map<String, Object> overloaded() {
        List<TransformerResponse> transformers = transformerService.listOverloaded(ThresholdEngine.LOAD_WARNING_PCT).stream()
            .map(TransformerResponse::of)
            .collect(Collectors.toList());
        return Map.of("overloadedTransformers", transformers, "count", transformers.size(), "warningThresholdPct", ThresholdEngine.LOAD_WARNING_PCT);
    }

    /** Feature 7 — identify high-temperature transformers. */
    @GetMapping("/transformers/high-temperature")
    public Map<String, Object> highTemperature() {
        List<TransformerResponse> transformers = transformerService.listHighTemperature(ThresholdEngine.TEMP_WARNING_C).stream()
            .map(TransformerResponse::of)
            .collect(Collectors.toList());
        return Map.of("highTemperatureTransformers", transformers, "count", transformers.size(), "warningThresholdC", ThresholdEngine.TEMP_WARNING_C);
    }

    /** Feature 4 — generate infrastructure alerts (overloaded + high-temp + failed + inspection-overdue, prioritized). */
    @GetMapping("/alerts")
    public Map<String, Object> alerts() {
        List<InfrastructureAlert> alerts = alertService.generateAlerts();
        return Map.of("alerts", alerts, "count", alerts.size());
    }

    /** Feature 3 (fleet-wide view) — every transformer with at least one abnormal reading right now. */
    @GetMapping("/anomalies")
    public Map<String, Object> anomalies() {
        List<AnomalyReport> reports = transformerService.listAll().stream()
            .map(telemetryService::checkCurrentReading)
            .filter(AnomalyReport::abnormal)
            .collect(Collectors.toList());
        return Map.of("anomalies", reports, "count", reports.size());
    }

    /**
     * Feature 8 — display infrastructure on a map. One call for
     * everything the frontend's map view needs: every substation's
     * coordinates plus its transformers' current status, so pins can
     * be colored by worst-status without N follow-up requests.
     */
    @GetMapping("/map")
    public Map<String, Object> map() {
        Map<UUID, List<Transformer>> transformersBySubstation = transformerService.listAll().stream()
            .collect(Collectors.groupingBy(Transformer::getSubstationId));

        List<MapMarker> markers = substationService.list().stream()
            .map(s -> {
                List<Transformer> transformers = transformersBySubstation.getOrDefault(s.getId(), List.of());
                InfraStatus worst = transformers.stream().map(Transformer::getStatus)
                    .reduce(InfraStatus.NORMAL, InfraStatus::worstOf);
                List<TransformerMapPoint> points = transformers.stream()
                    .map(t -> new TransformerMapPoint(t.getId(), t.getCode(), t.getStatus().name(), t.getLastLoadPercentage(), t.getLastTemperatureCelsius()))
                    .collect(Collectors.toList());
                return new MapMarker(s.getId(), s.getName(), s.getLatitude(), s.getLongitude(), s.getGridZone(),
                    worst.name(), transformers.size(), points);
            })
            .collect(Collectors.toList());

        return Map.of("markers", markers);
    }

    /** Dashboard summary — same "one call for every stat card" pattern as the other domain services. */
    @GetMapping("/stats/summary")
    public Map<String, Object> summary() {
        List<Substation> substations = substationService.list();
        List<Transformer> transformers = transformerService.listAll();

        Map<String, Long> byStatus = transformers.stream()
            .collect(Collectors.groupingBy(t -> t.getStatus().name(), Collectors.counting()));

        long overloaded = transformers.stream().filter(t -> t.getLastLoadPercentage() != null && t.getLastLoadPercentage() >= ThresholdEngine.LOAD_WARNING_PCT).count();
        long highTemp = transformers.stream().filter(t -> t.getLastTemperatureCelsius() != null && t.getLastTemperatureCelsius() >= ThresholdEngine.TEMP_WARNING_C).count();

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("totalSubstations", substations.size());
        summary.put("totalTransformers", transformers.size());
        summary.put("transformersByStatus", byStatus);
        summary.put("overloadedCount", overloaded);
        summary.put("highTemperatureCount", highTemp);
        summary.put("openAlertsCount", alertService.generateAlerts().size());

        return Map.of("summary", summary);
    }
}
