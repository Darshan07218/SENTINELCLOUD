package com.sentinelcloud.power.service;

import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.entity.TransformerReading;
import com.sentinelcloud.power.repository.TransformerFailureEventRepository;
import com.sentinelcloud.power.repository.TransformerReadingRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Phase 18: loads what TransformerRiskForecaster needs (the last 7 days of
 * readings, capped at 500, and the failures of the last 30 days) and
 * labels the result with the transformer and its substation.
 */
@Service
public class RiskForecastService {

    static final int WINDOW_DAYS = 7;
    static final int MAX_READINGS = 500;
    static final int FAILURE_WINDOW_DAYS = 30;

    private final TransformerService transformerService;
    private final SubstationService substationService;
    private final TransformerReadingRepository readingRepository;
    private final TransformerFailureEventRepository failureRepository;

    public RiskForecastService(TransformerService transformerService, SubstationService substationService,
                               TransformerReadingRepository readingRepository, TransformerFailureEventRepository failureRepository) {
        this.transformerService = transformerService;
        this.substationService = substationService;
        this.readingRepository = readingRepository;
        this.failureRepository = failureRepository;
    }

    public record TransformerRisk(UUID transformerId, String code, String name, UUID substationId, String substationName,
                                  String status, Instant lastReadingAt, Instant generatedAt,
                                  TransformerRiskForecaster.RiskForecast forecast) {}

    @Transactional(readOnly = true)
    public TransformerRisk forecast(UUID transformerId, int horizonHours) {
        Transformer transformer = transformerService.getOrThrow(transformerId);
        Substation substation = substationService.getOrThrow(transformer.getSubstationId());
        return forecast(transformer, substation.getName(), horizonHours, Instant.now());
    }

    /** Every transformer, highest risk score first. */
    @Transactional(readOnly = true)
    public List<TransformerRisk> forecastAll(int horizonHours) {
        Map<UUID, String> substationNames = substationService.list().stream()
            .collect(Collectors.toMap(Substation::getId, Substation::getName, (a, b) -> a));
        Instant now = Instant.now();
        return transformerService.listAll().stream()
            .map(t -> forecast(t, substationNames.getOrDefault(t.getSubstationId(), "?"), horizonHours, now))
            .sorted(Comparator.comparingInt((TransformerRisk r) -> r.forecast().score()).reversed()
                .thenComparing(TransformerRisk::code))
            .collect(Collectors.toList());
    }

    private TransformerRisk forecast(Transformer t, String substationName, int horizonHours, Instant now) {
        List<TransformerReading> newestFirst = readingRepository.findByTransformerIdAndRecordedAtAfterOrderByRecordedAtDesc(
            t.getId(), now.minus(WINDOW_DAYS, ChronoUnit.DAYS), PageRequest.of(0, MAX_READINGS));
        List<TransformerRiskForecaster.Sample> samples = newestFirst.reversed().stream()
            .map(r -> new TransformerRiskForecaster.Sample(r.getRecordedAt(), r.getLoadPercentage(), r.getTemperatureCelsius(), r.isAnomalous()))
            .toList();
        Instant failureCutoff = now.minus(FAILURE_WINDOW_DAYS, ChronoUnit.DAYS);
        int recentFailures = (int) failureRepository.findByTransformerIdOrderByOccurredAtDesc(t.getId()).stream()
            .filter(f -> f.getOccurredAt() != null && f.getOccurredAt().isAfter(failureCutoff))
            .count();
        TransformerRiskForecaster.RiskForecast forecast =
            TransformerRiskForecaster.forecast(samples, t.getStatus(), recentFailures, horizonHours);
        return new TransformerRisk(t.getId(), t.getCode(), t.getName(), t.getSubstationId(), substationName,
            t.getStatus().name(), t.getLastReadingAt(), now, forecast);
    }
}
