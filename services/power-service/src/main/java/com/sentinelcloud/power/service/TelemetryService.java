package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.domain.ReadingMetric;
import com.sentinelcloud.power.dto.TelemetryDtos.*;
import com.sentinelcloud.power.dto.TransformerDtos.SetStatusRequest;
import com.sentinelcloud.power.dto.TransformerDtos.TelemetryRequest;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.entity.TransformerFailureEvent;
import com.sentinelcloud.power.entity.TransformerReading;
import com.sentinelcloud.power.exception.NotFoundException;
import com.sentinelcloud.power.repository.TransformerFailureEventRepository;
import com.sentinelcloud.power.repository.TransformerReadingRepository;
import com.sentinelcloud.power.repository.TransformerRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Feature 2 (update telemetry) and feature 3 (detect abnormal
 * readings), plus historical-reading lookup (feature 5) and the
 * failure-history ledger. This is where ThresholdEngine (rule-based,
 * against this transformer's own rated values) and
 * AnomalyDetectionService (statistical, against this transformer's
 * own recent history) are actually invoked together against one new
 * reading.
 */
@Service
public class TelemetryService {

    /** How many of a transformer's most recent prior readings form its statistical baseline. */
    public static final int BASELINE_WINDOW_SIZE = 30;

    /** A transformer overdue for inspection if not inspected within this many days. */
    public static final int INSPECTION_OVERDUE_DAYS = 180;

    private final TransformerRepository transformerRepository;
    private final TransformerReadingRepository readingRepository;
    private final TransformerFailureEventRepository failureEventRepository;
    private final AnomalyDetectionService anomalyDetectionService;

    public TelemetryService(TransformerRepository transformerRepository, TransformerReadingRepository readingRepository,
                             TransformerFailureEventRepository failureEventRepository, AnomalyDetectionService anomalyDetectionService) {
        this.transformerRepository = transformerRepository;
        this.readingRepository = readingRepository;
        this.failureEventRepository = failureEventRepository;
        this.anomalyDetectionService = anomalyDetectionService;
    }

    /**
     * Feature 2. Records a new telemetry reading, evaluates it against
     * both rule-based thresholds and this transformer's own
     * statistical baseline, updates the transformer's live status +
     * denormalized snapshot, and opens/closes a failure-history event
     * on any status transition into or out of CRITICAL/FAILED.
     */
    @Transactional
    public TelemetryResult recordTelemetry(UUID transformerId, TelemetryRequest req, UUID recordedByUserId) {
        Transformer transformer = transformerRepository.findById(transformerId)
            .orElseThrow(() -> new NotFoundException("Transformer not found."));

        Instant recordedAt = req.recordedAt() != null ? req.recordedAt() : Instant.now();
        // Phase 12: a reading dated in the future would stay the "latest"
        // forever; one dated long ago is not live telemetry. A little clock
        // skew from the sender is tolerated.
        Instant now = Instant.now();
        if (recordedAt.isAfter(now.plusSeconds(300)) || recordedAt.isBefore(now.minusSeconds(30L * 24 * 3600))) {
            throw new IllegalArgumentException("recordedAt must be within the last 30 days and not in the future.");
        }

        // Baseline: this transformer's most recent prior readings, capped to a rolling window
        // (the repository method name already orders by recordedAt desc; the Pageable here only caps size).
        Pageable window = PageRequest.of(0, BASELINE_WINDOW_SIZE);
        List<TransformerReading> history = readingRepository.findByTransformerIdOrderByRecordedAtDesc(transformerId, window);

        ThresholdEngine.EvaluationResult ruleEvaluation = ThresholdEngine.evaluate(
            req.voltage(), req.currentAmps(), req.loadPercentage(), req.temperatureCelsius(),
            transformer.getRatedVoltageKv(), transformer.getRatedCurrentAmps());

        List<AnomalyDetectionService.StatisticalAnomaly> statisticalAnomalies = anomalyDetectionService.checkAllMetrics(
            req.voltage(), req.currentAmps(), req.loadPercentage(), req.temperatureCelsius(),
            valuesFor(history, ReadingMetric.VOLTAGE), valuesFor(history, ReadingMetric.CURRENT),
            valuesFor(history, ReadingMetric.LOAD_PERCENTAGE), valuesFor(history, ReadingMetric.TEMPERATURE));

        List<String> reasons = new ArrayList<>();
        for (var m : ruleEvaluation.abnormalMetrics()) {
            reasons.add(String.format("%s %s: %.1f (%.1f%% from rated/threshold reference %.1f)",
                m.status(), m.metric(), m.value(), m.deviationPct(), m.referenceValue()));
        }
        for (var a : statisticalAnomalies) {
            reasons.add(String.format("STATISTICAL %s: %.2f is %.2f std-dev from this transformer's own recent mean of %.2f",
                a.metric(), a.value(), a.zScore(), a.historicalMean()));
        }
        boolean anomalous = !reasons.isEmpty();

        TransformerReading reading = new TransformerReading(transformerId, req.voltage(), req.currentAmps(),
            req.loadPercentage(), req.temperatureCelsius(), anomalous, String.join(" | ", reasons), recordedAt);
        reading = readingRepository.save(reading);

        // A statistical anomaly nudges status to at least WARNING even if every metric is
        // still inside ThresholdEngine's fixed rated-value bands — that's the whole point of
        // tracking a transformer's own baseline separately from the fleet-wide fixed thresholds.
        InfraStatus newStatus = ruleEvaluation.overallStatus();
        if (!statisticalAnomalies.isEmpty() && newStatus == InfraStatus.NORMAL) {
            newStatus = InfraStatus.WARNING;
        }

        // A late-arriving (backdated) reading is stored in the history but
        // must not overwrite the live snapshot or status: the transformer's
        // state is defined by its NEWEST reading, not the last one received.
        InfraStatus previousStatus = transformer.getStatus();
        boolean isLatest = transformer.getLastReadingAt() == null || !recordedAt.isBefore(transformer.getLastReadingAt());
        boolean statusChanged = false;
        if (isLatest) {
            transformer.applyTelemetrySnapshot(req.voltage(), req.currentAmps(), req.loadPercentage(),
                req.temperatureCelsius(), recordedAt, newStatus);
            transformerRepository.save(transformer);
            statusChanged = previousStatus != newStatus;
            if (statusChanged) {
                handleStatusTransition(transformerId, previousStatus, newStatus, "Automatic threshold/anomaly evaluation on new telemetry.", recordedByUserId);
            }
        }

        return new TelemetryResult(ReadingResponse.of(reading), transformer.getStatus().name(), statusChanged, anomalous, reasons);
    }

    /** Explicit manual status override (e.g. INFRASTRUCTURE_ADMIN takes a transformer offline for maintenance). */
    @Transactional
    public Transformer setStatus(UUID transformerId, SetStatusRequest req, UUID recordedByUserId) {
        Transformer transformer = transformerRepository.findById(transformerId)
            .orElseThrow(() -> new NotFoundException("Transformer not found."));
        InfraStatus previousStatus = transformer.getStatus();
        InfraStatus newStatus = InfraStatus.valueOf(req.status());

        transformer.setStatus(newStatus);
        transformerRepository.save(transformer);

        if (previousStatus != newStatus) {
            handleStatusTransition(transformerId, previousStatus, newStatus, req.reason(), recordedByUserId);
        }
        return transformer;
    }

    private void handleStatusTransition(UUID transformerId, InfraStatus previousStatus, InfraStatus newStatus, String reason, UUID recordedByUserId) {
        boolean wasBad = previousStatus.severityRank() >= InfraStatus.CRITICAL.severityRank();
        boolean isBad = newStatus.severityRank() >= InfraStatus.CRITICAL.severityRank();

        // One failure episode = one open event. CRITICAL -> FAILED (or back)
        // is the same episode, so it must not open a second event; before
        // this fix it did, and the next recovery then failed every request
        // because the "open event" lookup found two rows.
        if (isBad && !wasBad) {
            failureEventRepository.save(new TransformerFailureEvent(transformerId, previousStatus, newStatus, reason, recordedByUserId));
        } else if (wasBad && !isBad) {
            // Resolve every open event (also heals rows left by the old bug).
            failureEventRepository.findByTransformerIdAndResolvedAtIsNull(transformerId).forEach(TransformerFailureEvent::resolve);
        }
    }

    /** Feature 5 — historical readings, most recent first, capped by limit. */
    public List<ReadingResponse> historicalReadings(UUID transformerId, int limit) {
        Pageable page = PageRequest.of(0, Math.max(1, Math.min(limit, 500)));
        return readingRepository.findByTransformerIdOrderByRecordedAtDesc(transformerId, page).stream()
            .map(ReadingResponse::of).collect(Collectors.toList());
    }

    public List<FailureEventResponse> failureHistory(UUID transformerId) {
        return failureEventRepository.findByTransformerIdOrderByOccurredAtDesc(transformerId).stream()
            .map(FailureEventResponse::of).collect(Collectors.toList());
    }

    /**
     * Feature 3 — re-runs abnormality detection against a
     * transformer's CURRENT live snapshot (rather than requiring a new
     * reading to be submitted), useful for an on-demand "is this
     * transformer currently OK" check from the dashboard.
     */
    public com.sentinelcloud.power.dto.MiscDtos.AnomalyReport checkCurrentReading(Transformer transformer) {
        if (transformer.getLastReadingAt() == null) {
            return new com.sentinelcloud.power.dto.MiscDtos.AnomalyReport(
                transformer.getId(), transformer.getCode(), false, List.of("No telemetry recorded yet."), List.of());
        }

        ThresholdEngine.EvaluationResult ruleEvaluation = ThresholdEngine.evaluate(
            transformer.getLastVoltage(), transformer.getLastCurrentAmps(), transformer.getLastLoadPercentage(),
            transformer.getLastTemperatureCelsius(), transformer.getRatedVoltageKv(), transformer.getRatedCurrentAmps());

        List<String> ruleFindings = ruleEvaluation.abnormalMetrics().stream()
            .map(m -> String.format("%s %s: %.1f (%.1f%% deviation)", m.status(), m.metric(), m.value(), m.deviationPct()))
            .collect(Collectors.toList());

        Pageable window = PageRequest.of(0, BASELINE_WINDOW_SIZE);
        List<TransformerReading> history = readingRepository.findByTransformerIdOrderByRecordedAtDesc(transformer.getId(), window);
        // Exclude the most recent reading from its own baseline (it IS the value being checked).
        List<TransformerReading> priorHistory = history.size() > 1 ? history.subList(1, history.size()) : List.of();

        List<AnomalyDetectionService.StatisticalAnomaly> statisticalAnomalies = anomalyDetectionService.checkAllMetrics(
            transformer.getLastVoltage(), transformer.getLastCurrentAmps(), transformer.getLastLoadPercentage(), transformer.getLastTemperatureCelsius(),
            valuesFor(priorHistory, ReadingMetric.VOLTAGE), valuesFor(priorHistory, ReadingMetric.CURRENT),
            valuesFor(priorHistory, ReadingMetric.LOAD_PERCENTAGE), valuesFor(priorHistory, ReadingMetric.TEMPERATURE));

        List<String> statFindings = statisticalAnomalies.stream()
            .map(a -> String.format("%s: %.2f is %.2f std-dev from recent mean %.2f", a.metric(), a.value(), a.zScore(), a.historicalMean()))
            .collect(Collectors.toList());

        boolean abnormal = !ruleFindings.isEmpty() || !statFindings.isEmpty();
        return new com.sentinelcloud.power.dto.MiscDtos.AnomalyReport(transformer.getId(), transformer.getCode(), abnormal, ruleFindings, statFindings);
    }

    private static List<Double> valuesFor(List<TransformerReading> readings, ReadingMetric metric) {
        return readings.stream().map(r -> switch (metric) {
            case VOLTAGE -> r.getVoltage();
            case CURRENT -> r.getCurrentAmps();
            case LOAD_PERCENTAGE -> r.getLoadPercentage();
            case TEMPERATURE -> r.getTemperatureCelsius();
        }).collect(Collectors.toList());
    }
}
