package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.InfraStatus;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ThresholdEngineTest {

    private static final double RATED_VOLTAGE = 33.0;
    private static final double RATED_CURRENT = 400.0;

    @Test
    void allMetricsWithinBandsProduceNormalOverallStatus() {
        var result = ThresholdEngine.evaluate(33.0, 400.0, 60.0, 40.0, RATED_VOLTAGE, RATED_CURRENT);

        assertEquals(InfraStatus.NORMAL, result.overallStatus());
        assertTrue(result.abnormalMetrics().isEmpty());
    }

    @Test
    void loadAtOrAboveWarningButBelowCriticalIsWarning() {
        var result = ThresholdEngine.evaluate(33.0, 400.0, ThresholdEngine.LOAD_WARNING_PCT, 40.0, RATED_VOLTAGE, RATED_CURRENT);

        assertEquals(InfraStatus.WARNING, result.overallStatus());
    }

    @Test
    void loadAtOrAboveCriticalIsCritical() {
        var result = ThresholdEngine.evaluate(33.0, 400.0, ThresholdEngine.LOAD_CRITICAL_PCT, 40.0, RATED_VOLTAGE, RATED_CURRENT);

        assertEquals(InfraStatus.CRITICAL, result.overallStatus());
    }

    @Test
    void loadAtOrAboveFailureIsFailed() {
        var result = ThresholdEngine.evaluate(33.0, 400.0, ThresholdEngine.LOAD_FAILURE_PCT, 40.0, RATED_VOLTAGE, RATED_CURRENT);

        assertEquals(InfraStatus.FAILED, result.overallStatus());
    }

    @Test
    void highTemperatureAloneDrivesOverallStatusToCritical() {
        var result = ThresholdEngine.evaluate(33.0, 400.0, 50.0, ThresholdEngine.TEMP_CRITICAL_C, RATED_VOLTAGE, RATED_CURRENT);

        assertEquals(InfraStatus.CRITICAL, result.overallStatus());
        assertTrue(result.abnormalMetrics().stream().anyMatch(m -> m.metric().name().equals("TEMPERATURE")));
    }

    @Test
    void voltageDeviationIsMeasuredAsPercentageOfRatedValueNotAbsoluteVolts() {
        // 10% below a 33kV rating = 29.7kV, right at the warning boundary.
        double warningVoltage = RATED_VOLTAGE * (1 - ThresholdEngine.VOLTAGE_DEVIATION_WARNING_PCT / 100.0);
        var result = ThresholdEngine.evaluate(warningVoltage, 400.0, 50.0, 40.0, RATED_VOLTAGE, RATED_CURRENT);

        assertEquals(InfraStatus.WARNING, result.overallStatus());

        // The same 3.3kV absolute deviation on a much higher-rated 220kV transformer is
        // well under 10% and should NOT trigger a warning — deviation is relative, not absolute.
        var highRatedResult = ThresholdEngine.evaluate(220.0 - 3.3, 400.0, 50.0, 40.0, 220.0, RATED_CURRENT);
        assertEquals(InfraStatus.NORMAL, highRatedResult.overallStatus());
    }

    @Test
    void overallStatusIsTheWorstOfAllFourMetrics() {
        // Load is fine, but temperature is at FAILED-level — overall must reflect the worst metric.
        var result = ThresholdEngine.evaluate(33.0, 400.0, 50.0, ThresholdEngine.TEMP_FAILURE_C, RATED_VOLTAGE, RATED_CURRENT);

        assertEquals(InfraStatus.FAILED, result.overallStatus());
    }

    @Test
    void worstOfPicksTheHigherSeverityRegardlessOfArgumentOrder() {
        assertEquals(InfraStatus.CRITICAL, InfraStatus.worstOf(InfraStatus.WARNING, InfraStatus.CRITICAL));
        assertEquals(InfraStatus.CRITICAL, InfraStatus.worstOf(InfraStatus.CRITICAL, InfraStatus.WARNING));
        assertEquals(InfraStatus.FAILED, InfraStatus.worstOf(InfraStatus.FAILED, InfraStatus.NORMAL));
    }
}
