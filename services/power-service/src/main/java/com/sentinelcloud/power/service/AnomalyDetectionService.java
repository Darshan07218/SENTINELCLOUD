package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.ReadingMetric;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * The statistical half of anomaly detection (see ThresholdEngine for
 * the rule-based half). Pure math, no Spring wiring beyond
 * {@code @Component} so it can be dependency-injected — every method
 * here takes plain {@code List<Double>} history rather than JPA
 * entities, so it's trivially unit-testable without a database (see
 * src/test/.../AnomalyDetectionServiceTest.java).
 *
 * Approach: a transformer builds up its own baseline over time (mean
 * + population standard deviation of its past N readings for a given
 * metric). A new reading is flagged anomalous if it's more than
 * Z_SCORE_THRESHOLD standard deviations from that transformer's own
 * baseline — i.e. this is unusual *for this specific transformer*,
 * which catches drift/degradation even for a transformer whose
 * absolute values are still technically inside ThresholdEngine's
 * fixed rated-value bands. Requires a minimum history size; with too
 * few points a standard deviation is meaningless, so instead of a
 * false-confidence answer we report "not enough history yet."
 */
@Component
public class AnomalyDetectionService {

    /** Below this many prior readings, a std-dev-based baseline isn't statistically meaningful. */
    public static final int MIN_HISTORY_FOR_BASELINE = 5;

    /** How many standard deviations from this transformer's own mean counts as anomalous. */
    public static final double Z_SCORE_THRESHOLD = 2.5;

    public record StatisticalAnomaly(ReadingMetric metric, double value, double historicalMean, double historicalStdDev, double zScore) {}

    public record AnomalyCheck(boolean sufficientHistory, int historySize, List<StatisticalAnomaly> anomalies) {
        public boolean isAnomalous() {
            return !anomalies.isEmpty();
        }
    }

    /**
     * Checks one new value against the transformer's own historical
     * values for that same metric (history should NOT include the new
     * value itself — it's the baseline the new value is compared
     * against).
     */
    public AnomalyCheck checkMetric(ReadingMetric metric, double newValue, List<Double> history) {
        if (history.size() < MIN_HISTORY_FOR_BASELINE) {
            return new AnomalyCheck(false, history.size(), List.of());
        }

        double mean = mean(history);
        double stdDev = stdDev(history, mean);

        // A perfectly flat history (stdDev == 0, e.g. every prior reading identical) can't
        // produce a meaningful z-score by division — treat any deviation at all as anomalous
        // in that edge case rather than dividing by zero.
        double zScore = stdDev == 0 ? (newValue == mean ? 0 : Double.POSITIVE_INFINITY) : Math.abs(newValue - mean) / stdDev;

        List<StatisticalAnomaly> anomalies = new ArrayList<>();
        if (zScore >= Z_SCORE_THRESHOLD) {
            anomalies.add(new StatisticalAnomaly(metric, round2(newValue), round2(mean), round2(stdDev), round2(zScore)));
        }
        return new AnomalyCheck(true, history.size(), anomalies);
    }

    /** Convenience overload for checking all four metrics of one new reading at once against per-metric histories. */
    public List<StatisticalAnomaly> checkAllMetrics(double voltage, double currentAmps, double loadPercentage, double temperatureCelsius,
                                                      List<Double> voltageHistory, List<Double> currentHistory,
                                                      List<Double> loadHistory, List<Double> temperatureHistory) {
        List<StatisticalAnomaly> anomalies = new ArrayList<>();
        anomalies.addAll(checkMetric(ReadingMetric.VOLTAGE, voltage, voltageHistory).anomalies());
        anomalies.addAll(checkMetric(ReadingMetric.CURRENT, currentAmps, currentHistory).anomalies());
        anomalies.addAll(checkMetric(ReadingMetric.LOAD_PERCENTAGE, loadPercentage, loadHistory).anomalies());
        anomalies.addAll(checkMetric(ReadingMetric.TEMPERATURE, temperatureCelsius, temperatureHistory).anomalies());
        return anomalies;
    }

    private static double mean(List<Double> values) {
        double sum = 0;
        for (double v : values) sum += v;
        return sum / values.size();
    }

    private static double stdDev(List<Double> values, double mean) {
        double sumSquaredDiff = 0;
        for (double v : values) sumSquaredDiff += (v - mean) * (v - mean);
        return Math.sqrt(sumSquaredDiff / values.size());
    }

    private static double round2(double value) {
        return Math.round(value * 100.0) / 100.0;
    }
}
