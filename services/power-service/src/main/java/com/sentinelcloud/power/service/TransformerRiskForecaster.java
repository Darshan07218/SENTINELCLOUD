package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.InfraStatus;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Phase 18: transformer-risk forecast (docs/PHASE-18-MAPS-AND-FORECASTS.md §3).
 *
 * Pure math like ThresholdEngine: no Spring, no database. Input: a
 * transformer's recent readings (oldest first), its current status and
 * how often it failed lately. Output: where load and temperature are
 * heading, when each would cross its CRITICAL line, a 0–100 risk score
 * with a level, and the reasons in plain words.
 *
 * Trend: an ordinary least-squares line through the readings (per metric,
 * against time in hours). The projection starts from the latest reading
 * and is never extrapolated further ahead than the history behind it
 * (two hours of readings say nothing about tomorrow).
 *
 * Score (weights add up to 100):
 *   temperature, highest of now and projected, from 45 °C (0) to 105 °C failure (1) → 40
 *   load,        highest of now and projected, from 60 % (0) to 150 % failure (1)  → 35
 *   failures in the last 30 days, three or more counts fully                      → 15
 *   share of the window's readings that were anomalous                            → 10
 * A FAILED transformer scores 100.
 */
public final class TransformerRiskForecaster {

    private TransformerRiskForecaster() {}

    public static final int MIN_READINGS = 3;
    public static final double MIN_SPAN_HOURS = 1.0;

    static final double TEMP_SCORE_FROM_C = 45.0;
    static final double LOAD_SCORE_FROM_PCT = 60.0;
    static final double WEIGHT_TEMP = 40, WEIGHT_LOAD = 35, WEIGHT_FAILURES = 15, WEIGHT_ANOMALIES = 10;

    public record Sample(Instant at, double loadPercentage, double temperatureCelsius, boolean anomalous) {}

    /** One metric's trend. hoursToCritical: 0 if already there, null if not within the horizon. */
    public record MetricTrend(double current, double slopePerHour, double projected, double criticalLevel, Double hoursToCritical) {}

    public record ProjectionPoint(int hoursAhead, double loadPercentage, double temperatureCelsius) {}

    public record RiskForecast(
        String status,             // OK | INSUFFICIENT_DATA (no trend: too few readings or too short a span)
        int score,                 // 0–100
        String level,              // LOW | MODERATE | HIGH | CRITICAL
        int horizonHours,
        int readingsUsed,
        double historyHours,
        MetricTrend load,
        MetricTrend temperature,
        int failuresLast30Days,
        double anomalyRate,
        List<String> reasons,
        List<ProjectionPoint> projection
    ) {}

    public static RiskForecast forecast(List<Sample> samples, InfraStatus currentStatus, int failuresLast30Days, int horizonHours) {
        int n = samples.size();
        if (n == 0) {
            List<String> reasons = new ArrayList<>();
            reasons.add("No telemetry recorded yet");
            int score = currentStatus == InfraStatus.FAILED ? 100 : (int) Math.round(failureComponent(failuresLast30Days));
            if (currentStatus == InfraStatus.FAILED) reasons.add(0, "Currently FAILED");
            return new RiskForecast("INSUFFICIENT_DATA", score, levelFor(score, null, horizonHours), horizonHours, 0, 0,
                null, null, failuresLast30Days, 0, reasons, List.of());
        }

        Sample first = samples.get(0);
        Sample latest = samples.get(n - 1);
        double spanHours = hoursBetween(first.at(), latest.at());
        boolean enough = n >= MIN_READINGS && spanHours >= MIN_SPAN_HOURS;

        double[] x = new double[n];
        double[] load = new double[n];
        double[] temp = new double[n];
        int anomalies = 0;
        for (int i = 0; i < n; i++) {
            Sample s = samples.get(i);
            x[i] = hoursBetween(first.at(), s.at());
            load[i] = s.loadPercentage();
            temp[i] = s.temperatureCelsius();
            if (s.anomalous()) anomalies++;
        }
        double anomalyRate = (double) anomalies / n;
        double effectiveHours = Math.min(horizonHours, spanHours);

        MetricTrend loadTrend = trend(latest.loadPercentage(), enough ? slope(x, load) : 0, effectiveHours,
            ThresholdEngine.LOAD_CRITICAL_PCT, horizonHours);
        MetricTrend tempTrend = trend(latest.temperatureCelsius(), enough ? slope(x, temp) : 0, effectiveHours,
            ThresholdEngine.TEMP_CRITICAL_C, horizonHours);

        double peakTemp = Math.max(tempTrend.current(), tempTrend.projected());
        double peakLoad = Math.max(loadTrend.current(), loadTrend.projected());
        double raw = WEIGHT_TEMP * ramp(peakTemp, TEMP_SCORE_FROM_C, ThresholdEngine.TEMP_FAILURE_C)
            + WEIGHT_LOAD * ramp(peakLoad, LOAD_SCORE_FROM_PCT, ThresholdEngine.LOAD_FAILURE_PCT)
            + failureComponent(failuresLast30Days)
            + WEIGHT_ANOMALIES * anomalyRate;
        int score = currentStatus == InfraStatus.FAILED ? 100 : (int) Math.round(Math.min(100, raw));

        Double soonest = minNullable(loadTrend.hoursToCritical(), tempTrend.hoursToCritical());
        String level = levelFor(score, soonest, horizonHours);

        List<String> reasons = new ArrayList<>();
        if (currentStatus == InfraStatus.FAILED) reasons.add("Currently FAILED");
        describe(reasons, "Temperature", "°C", tempTrend, horizonHours);
        describe(reasons, "Load", "%", loadTrend, horizonHours);
        if (failuresLast30Days > 0) reasons.add(failuresLast30Days + " failure(s) in the last 30 days");
        if (anomalies > 0) reasons.add(Math.round(anomalyRate * 100) + "% of recent readings were anomalous");
        if (!enough) reasons.add("Not enough history for a trend (" + n + " reading(s) over " + round1(spanHours) + " h); current values only");
        if (reasons.isEmpty()) reasons.add("Load and temperature steady and well inside their limits");

        List<ProjectionPoint> projection = new ArrayList<>();
        for (int h = 0; h <= horizonHours; h++) {
            double ahead = Math.min(h, spanHours);
            projection.add(new ProjectionPoint(h,
                round1(Math.max(0, loadTrend.current() + loadTrend.slopePerHour() * ahead)),
                round1(Math.max(0, tempTrend.current() + tempTrend.slopePerHour() * ahead))));
        }

        return new RiskForecast(enough ? "OK" : "INSUFFICIENT_DATA", score, level, horizonHours, n, round1(spanHours),
            loadTrend, tempTrend, failuresLast30Days, round2(anomalyRate), reasons, projection);
    }

    /** LOW <25 ≤ MODERATE <50 ≤ HIGH <75 ≤ CRITICAL; crossing a CRITICAL line within the horizon is at least HIGH, within 6 h CRITICAL. */
    static String levelFor(int score, Double hoursToCritical, int horizonHours) {
        String level = score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MODERATE" : "LOW";
        if (hoursToCritical != null && hoursToCritical <= 6) return "CRITICAL";
        if (hoursToCritical != null && hoursToCritical <= horizonHours && (level.equals("LOW") || level.equals("MODERATE"))) return "HIGH";
        return level;
    }

    private static MetricTrend trend(double current, double slopePerHour, double effectiveHours, double critical, int horizonHours) {
        double projected = Math.max(0, current + slopePerHour * effectiveHours);
        Double hoursToCritical = null;
        if (current >= critical) {
            hoursToCritical = 0.0;
        } else if (slopePerHour > 0) {
            double h = (critical - current) / slopePerHour;
            if (h <= Math.min(horizonHours, effectiveHours)) hoursToCritical = round1(h);
        }
        return new MetricTrend(round1(current), round2(slopePerHour), round1(projected), critical, hoursToCritical);
    }

    private static void describe(List<String> reasons, String name, String unit, MetricTrend t, int horizonHours) {
        String limit = " (critical " + fmt(t.criticalLevel()) + unit + ")";
        if (t.hoursToCritical() != null && t.hoursToCritical() == 0) {
            reasons.add(name + " at " + fmt(t.current()) + unit + ", at or above critical" + limit);
        } else if (t.hoursToCritical() != null) {
            reasons.add(name + " rising " + fmt(t.slopePerHour()) + unit + "/h, critical in about " + fmt(t.hoursToCritical()) + " h" + limit);
        } else if (t.projected() >= t.criticalLevel() * 0.85) {
            reasons.add(name + " projected " + fmt(t.projected()) + unit + " within " + horizonHours + " h" + limit);
        }
    }

    /** Least-squares slope of y over x (0 if x has no spread). */
    static double slope(double[] x, double[] y) {
        int n = x.length;
        double mx = 0, my = 0;
        for (int i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
        mx /= n; my /= n;
        double sxy = 0, sxx = 0;
        for (int i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx); }
        return sxx == 0 ? 0 : sxy / sxx;
    }

    private static double failureComponent(int failures) {
        return WEIGHT_FAILURES * Math.min(failures, 3) / 3.0;
    }

    private static double ramp(double value, double from, double to) {
        return Math.max(0, Math.min(1, (value - from) / (to - from)));
    }

    private static double hoursBetween(Instant a, Instant b) {
        return Duration.between(a, b).toMillis() / 3_600_000.0;
    }

    private static Double minNullable(Double a, Double b) {
        if (a == null) return b;
        if (b == null) return a;
        return Math.min(a, b);
    }

    private static double round1(double v) { return Math.round(v * 10.0) / 10.0; }
    private static double round2(double v) { return Math.round(v * 100.0) / 100.0; }
    private static String fmt(double v) { return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(round1(v)); }
}
