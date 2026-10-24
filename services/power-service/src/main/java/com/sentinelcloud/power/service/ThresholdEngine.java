package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.domain.ReadingMetric;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Pure, no-Spring, no-DB domain-threshold engine — mirrors the same
 * "pure math class, easy to unit test in isolation" pattern as
 * blood-bank-service's GeoUtils. This is the rule-based half of
 * anomaly detection (see AnomalyDetectionService for the statistical
 * half); together they answer "is this reading abnormal, and how
 * abnormal."
 *
 * Voltage and current are evaluated as a percentage deviation from
 * the transformer's own rated values (every transformer has a
 * different rated voltage/current, so an absolute threshold would be
 * meaningless across transformers). Load percentage and temperature
 * already are absolute/normalized units, so they use fixed
 * thresholds directly.
 */
public final class ThresholdEngine {

    private ThresholdEngine() {}

    // ---- Voltage / current: percentage deviation from rated value ----
    public static final double VOLTAGE_DEVIATION_WARNING_PCT = 10.0;
    public static final double VOLTAGE_DEVIATION_CRITICAL_PCT = 20.0;
    public static final double VOLTAGE_DEVIATION_FAILURE_PCT = 35.0;

    public static final double CURRENT_DEVIATION_WARNING_PCT = 15.0;
    public static final double CURRENT_DEVIATION_CRITICAL_PCT = 30.0;
    public static final double CURRENT_DEVIATION_FAILURE_PCT = 50.0;

    // ---- Load percentage: absolute, 100% == rated capacity ----
    public static final double LOAD_WARNING_PCT = 85.0;
    public static final double LOAD_CRITICAL_PCT = 100.0;
    public static final double LOAD_FAILURE_PCT = 150.0;

    // ---- Temperature: absolute degrees Celsius ----
    public static final double TEMP_WARNING_C = 65.0;
    public static final double TEMP_CRITICAL_C = 85.0;
    public static final double TEMP_FAILURE_C = 105.0;

    public record MetricEvaluation(ReadingMetric metric, InfraStatus status, double value, double referenceValue, double deviationPct) {
        public boolean isAbnormal() {
            return status != InfraStatus.NORMAL;
        }
    }

    public record EvaluationResult(InfraStatus overallStatus, List<MetricEvaluation> metricEvaluations) {
        public List<MetricEvaluation> abnormalMetrics() {
            return metricEvaluations.stream().filter(MetricEvaluation::isAbnormal).toList();
        }
    }

    /**
     * Evaluates one telemetry snapshot against a transformer's rated
     * voltage/current. Overall status is the worst (highest-severity)
     * of the four individual metric evaluations.
     */
    public static EvaluationResult evaluate(double voltage, double currentAmps, double loadPercentage, double temperatureCelsius,
                                             double ratedVoltageKv, double ratedCurrentAmps) {
        List<MetricEvaluation> evaluations = new ArrayList<>();

        evaluations.add(evaluateDeviation(ReadingMetric.VOLTAGE, voltage, ratedVoltageKv,
            VOLTAGE_DEVIATION_WARNING_PCT, VOLTAGE_DEVIATION_CRITICAL_PCT, VOLTAGE_DEVIATION_FAILURE_PCT));
        evaluations.add(evaluateDeviation(ReadingMetric.CURRENT, currentAmps, ratedCurrentAmps,
            CURRENT_DEVIATION_WARNING_PCT, CURRENT_DEVIATION_CRITICAL_PCT, CURRENT_DEVIATION_FAILURE_PCT));
        evaluations.add(evaluateAbsolute(ReadingMetric.LOAD_PERCENTAGE, loadPercentage,
            LOAD_WARNING_PCT, LOAD_CRITICAL_PCT, LOAD_FAILURE_PCT));
        evaluations.add(evaluateAbsolute(ReadingMetric.TEMPERATURE, temperatureCelsius,
            TEMP_WARNING_C, TEMP_CRITICAL_C, TEMP_FAILURE_C));

        InfraStatus overall = InfraStatus.NORMAL;
        for (MetricEvaluation e : evaluations) {
            overall = InfraStatus.worstOf(overall, e.status());
        }
        return new EvaluationResult(overall, evaluations);
    }

    /** Voltage/current: status driven by |value - reference| / reference, as a percentage. */
    private static MetricEvaluation evaluateDeviation(ReadingMetric metric, double value, double referenceValue,
                                                        double warningPct, double criticalPct, double failurePct) {
        double deviationPct = referenceValue == 0 ? 0 : Math.abs(value - referenceValue) / referenceValue * 100.0;
        InfraStatus status = statusForMagnitude(deviationPct, warningPct, criticalPct, failurePct);
        return new MetricEvaluation(metric, status, value, referenceValue, round1(deviationPct));
    }

    /** Load percentage/temperature: status driven directly by the absolute value crossing fixed bands. */
    private static MetricEvaluation evaluateAbsolute(ReadingMetric metric, double value,
                                                       double warningLevel, double criticalLevel, double failureLevel) {
        InfraStatus status = statusForMagnitude(value, warningLevel, criticalLevel, failureLevel);
        return new MetricEvaluation(metric, status, value, warningLevel, round1(value));
    }

    private static InfraStatus statusForMagnitude(double magnitude, double warning, double critical, double failure) {
        if (magnitude >= failure) return InfraStatus.FAILED;
        if (magnitude >= critical) return InfraStatus.CRITICAL;
        if (magnitude >= warning) return InfraStatus.WARNING;
        return InfraStatus.NORMAL;
    }

    private static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    /** Map form, convenient for callers that want to look a metric up directly rather than scan a list. */
    public static Map<ReadingMetric, MetricEvaluation> asMap(EvaluationResult result) {
        Map<ReadingMetric, MetricEvaluation> map = new EnumMap<>(ReadingMetric.class);
        for (MetricEvaluation e : result.metricEvaluations()) {
            map.put(e.metric(), e);
        }
        return map;
    }
}
