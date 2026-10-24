package com.sentinelcloud.power.controller;

import jakarta.validation.constraints.*;
import com.sentinelcloud.power.dto.TelemetryDtos.*;
import com.sentinelcloud.power.dto.TransformerDtos.*;
import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.security.AuthenticatedUser;
import com.sentinelcloud.power.service.RiskForecastService;
import com.sentinelcloud.power.service.SubstationService;
import com.sentinelcloud.power.service.TelemetryService;
import com.sentinelcloud.power.service.TransformerService;
import jakarta.validation.Valid;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Feature 2 (update telemetry), feature 3 (detect abnormal readings,
 * on-demand check), feature 5 (view historical readings), and the
 * failure-history / manual-status-override endpoints. Mirrors
 * blood-bank-service's ReservationController (a second controller for
 * a nested-but-independently-addressable resource).
 */
@RestController
@RequestMapping("/transformers")
public class TransformerController {

    private final TransformerService transformerService;
    private final TelemetryService telemetryService;
    private final SubstationService substationService;
    private final RiskForecastService riskForecastService;

    public TransformerController(TransformerService transformerService, TelemetryService telemetryService, SubstationService substationService,
                                 RiskForecastService riskForecastService) {
        this.transformerService = transformerService;
        this.telemetryService = telemetryService;
        this.substationService = substationService;
        this.riskForecastService = riskForecastService;
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable UUID id) {
        return Map.of("transformer", TransformerResponse.of(transformerService.getOrThrow(id)));
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasAnyRole('INFRASTRUCTURE_ADMIN', 'SYSTEM_ADMIN')")
    public Map<String, Object> update(@PathVariable UUID id, @Valid @RequestBody UpdateTransformerRequest req,
                                       @AuthenticationPrincipal AuthenticatedUser caller) {
        assertManagesTransformer(id, caller);
        return Map.of("transformer", TransformerResponse.of(transformerService.update(id, req)));
    }

    // -------------------------------------------------------------
    // Feature 2 — update telemetry (records a reading + re-evaluates status/anomalies)
    // -------------------------------------------------------------
    @PostMapping("/{id}/telemetry")
    @PreAuthorize("hasAnyRole('INFRASTRUCTURE_ADMIN', 'SYSTEM_ADMIN')")
    public Map<String, Object> recordTelemetry(@PathVariable UUID id, @Valid @RequestBody TelemetryRequest req,
                                                @AuthenticationPrincipal AuthenticatedUser caller) {
        assertManagesTransformer(id, caller);
        TelemetryResult result = telemetryService.recordTelemetry(id, req, caller.id());
        return Map.of("telemetry", result);
    }

    // -------------------------------------------------------------
    // Feature 5 — view historical readings
    // -------------------------------------------------------------
    @GetMapping("/{id}/readings")
    public Map<String, Object> readings(@PathVariable UUID id, @RequestParam(defaultValue = "50") @Min(1) @Max(500) int limit) {
        List<ReadingResponse> readings = telemetryService.historicalReadings(id, limit);
        return Map.of("readings", readings, "count", readings.size());
    }

    // -------------------------------------------------------------
    // Feature 3 — detect abnormal readings (on-demand check of the transformer's current snapshot)
    // -------------------------------------------------------------
    @GetMapping("/{id}/anomalies")
    public Map<String, Object> anomalies(@PathVariable UUID id) {
        Transformer transformer = transformerService.getOrThrow(id);
        return Map.of("anomalyReport", telemetryService.checkCurrentReading(transformer));
    }

    // -------------------------------------------------------------
    // Phase 18 — risk forecast for one transformer (trend, projection, reasons)
    // -------------------------------------------------------------
    @GetMapping("/{id}/risk-forecast")
    public Map<String, Object> riskForecast(@PathVariable UUID id,
                                            @RequestParam(defaultValue = "24") @Min(1) @Max(72) int horizonHours) {
        return Map.of("risk", riskForecastService.forecast(id, horizonHours));
    }

    @GetMapping("/{id}/failures")
    public Map<String, Object> failureHistory(@PathVariable UUID id) {
        List<FailureEventResponse> events = telemetryService.failureHistory(id);
        return Map.of("failureHistory", events, "count", events.size());
    }

    @PostMapping("/{id}/status")
    @PreAuthorize("hasAnyRole('INFRASTRUCTURE_ADMIN', 'SYSTEM_ADMIN')")
    public Map<String, Object> setStatus(@PathVariable UUID id, @Valid @RequestBody SetStatusRequest req,
                                          @AuthenticationPrincipal AuthenticatedUser caller) {
        assertManagesTransformer(id, caller);
        Transformer transformer = telemetryService.setStatus(id, req, caller.id());
        return Map.of("transformer", TransformerResponse.of(transformer));
    }

    private void assertManagesTransformer(UUID transformerId, AuthenticatedUser caller) {
        Transformer transformer = transformerService.getOrThrow(transformerId);
        Substation substation = substationService.getOrThrow(transformer.getSubstationId());
        substationService.assertManages(substation, caller);
    }
}
