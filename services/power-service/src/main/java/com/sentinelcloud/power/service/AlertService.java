package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.dto.MiscDtos.AlertSeverity;
import com.sentinelcloud.power.dto.MiscDtos.InfrastructureAlert;
import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.entity.TransformerFailureEvent;
import com.sentinelcloud.power.repository.SubstationRepository;
import com.sentinelcloud.power.repository.TransformerFailureEventRepository;
import com.sentinelcloud.power.repository.TransformerRepository;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.Comparator;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Feature 4 — aggregates overloaded (feature 6), high-temperature
 * (feature 7), failed/critical transformers, and inspection-overdue
 * transformers into one prioritized alert feed. Same "compute alerts,
 * don't just expose raw thresholds separately" pattern
 * blood-bank-service's AlertService uses.
 */
@Service
public class AlertService {

    private final TransformerRepository transformerRepository;
    private final SubstationRepository substationRepository;
    private final TransformerFailureEventRepository failureEventRepository;

    public AlertService(TransformerRepository transformerRepository, SubstationRepository substationRepository,
                         TransformerFailureEventRepository failureEventRepository) {
        this.transformerRepository = transformerRepository;
        this.substationRepository = substationRepository;
        this.failureEventRepository = failureEventRepository;
    }

    public java.util.List<InfrastructureAlert> generateAlerts() {
        Map<UUID, Substation> substationsById = substationRepository.findAll().stream()
            .collect(Collectors.toMap(Substation::getId, s -> s));

        Stream<InfrastructureAlert> overloadAlerts = transformerRepository.findOverloaded(ThresholdEngine.LOAD_WARNING_PCT).stream()
            .map(t -> {
                AlertSeverity sev = t.getLastLoadPercentage() >= ThresholdEngine.LOAD_FAILURE_PCT ? AlertSeverity.FAILED
                    : t.getLastLoadPercentage() >= ThresholdEngine.LOAD_CRITICAL_PCT ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
                Substation s = substationsById.get(t.getSubstationId());
                String message = String.format("Transformer %s is overloaded at %.1f%% of rated capacity.", t.getCode(), t.getLastLoadPercentage());
                return alert(sev, "OVERLOADED", s, t, message, t.getLastReadingAt());
            });

        Stream<InfrastructureAlert> temperatureAlerts = transformerRepository.findHighTemperature(ThresholdEngine.TEMP_WARNING_C).stream()
            .map(t -> {
                AlertSeverity sev = t.getLastTemperatureCelsius() >= ThresholdEngine.TEMP_FAILURE_C ? AlertSeverity.FAILED
                    : t.getLastTemperatureCelsius() >= ThresholdEngine.TEMP_CRITICAL_C ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
                Substation s = substationsById.get(t.getSubstationId());
                String message = String.format("Transformer %s is running hot at %.1f°C.", t.getCode(), t.getLastTemperatureCelsius());
                return alert(sev, "HIGH_TEMPERATURE", s, t, message, t.getLastReadingAt());
            });

        Stream<InfrastructureAlert> failedAlerts = transformerRepository.findByStatus(InfraStatus.FAILED).stream()
            .map(t -> {
                Substation s = substationsById.get(t.getSubstationId());
                String message = String.format("Transformer %s has FAILED and requires immediate attention.", t.getCode());
                return alert(AlertSeverity.FAILED, "TRANSFORMER_FAILED", s, t, message, t.getLastReadingAt());
            });

        Stream<InfrastructureAlert> inspectionAlerts = transformerRepository
            .findInspectionOverdue(LocalDate.now().minusDays(TelemetryService.INSPECTION_OVERDUE_DAYS)).stream()
            .map(t -> {
                Substation s = substationsById.get(t.getSubstationId());
                String when = t.getLastInspectionDate() == null ? "never" : ("on " + t.getLastInspectionDate());
                String message = String.format("Transformer %s is overdue for inspection (last inspected %s).", t.getCode(), when);
                return alert(AlertSeverity.WARNING, "INSPECTION_OVERDUE", s, t, message, null);
            });

        return Stream.of(overloadAlerts, temperatureAlerts, failedAlerts, inspectionAlerts)
            .flatMap(s -> s)
            .sorted(Comparator.comparingInt((InfrastructureAlert a) -> severityRank(a.severity())).reversed())
            .collect(Collectors.toList());
    }

    public java.util.List<TransformerFailureEvent> openFailureEvents() {
        return failureEventRepository.findByResolvedAtIsNull();
    }

    private static InfrastructureAlert alert(AlertSeverity severity, String type, Substation s, Transformer t, String message, java.time.Instant occurredAt) {
        return new InfrastructureAlert(severity, type, s != null ? s.getId() : null, s != null ? s.getName() : "Unknown substation",
            t.getId(), t.getCode(), message, occurredAt);
    }

    private static int severityRank(AlertSeverity severity) {
        return switch (severity) {
            case WARNING -> 0;
            case CRITICAL -> 1;
            case FAILED -> 2;
        };
    }
}
