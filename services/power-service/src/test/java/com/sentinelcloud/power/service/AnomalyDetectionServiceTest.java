package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.ReadingMetric;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class AnomalyDetectionServiceTest {

    private AnomalyDetectionService service;

    @BeforeEach
    void setUp() {
        service = new AnomalyDetectionService();
    }

    @Test
    void withFewerThanMinimumHistoryReportsInsufficientHistoryRatherThanGuessing() {
        List<Double> shortHistory = List.of(40.0, 40.2, 39.8);

        var check = service.checkMetric(ReadingMetric.TEMPERATURE, 41.0, shortHistory);

        assertFalse(check.sufficientHistory());
        assertTrue(check.anomalies().isEmpty());
        assertEquals(3, check.historySize());
    }

    @Test
    void aValueCloseToTheStableHistoricalMeanIsNotFlagged() {
        List<Double> stableHistory = List.of(40.0, 40.2, 39.8, 40.1, 39.9, 40.0, 40.3);

        var check = service.checkMetric(ReadingMetric.TEMPERATURE, 40.2, stableHistory);

        assertTrue(check.sufficientHistory());
        assertFalse(check.isAnomalous());
    }

    @Test
    void aValueSeveralStandardDeviationsFromAStableBaselineIsFlaggedAnomalous() {
        // Tight baseline (std dev well under 1) around 220 — a jump to 226 is many std devs away
        // even though it's a small absolute/percentage change, which is exactly the case
        // ThresholdEngine's fixed rated-value bands would likely miss.
        List<Double> tightHistory = List.of(220.0, 220.1, 219.9, 220.2, 219.8, 220.0, 220.1);

        var check = service.checkMetric(ReadingMetric.VOLTAGE, 226.0, tightHistory);

        assertTrue(check.sufficientHistory());
        assertTrue(check.isAnomalous());
        assertEquals(1, check.anomalies().size());
        assertTrue(check.anomalies().get(0).zScore() >= AnomalyDetectionService.Z_SCORE_THRESHOLD);
    }

    @Test
    void aFlatHistoryWithAnIdenticalNewValueIsNotAnomalousDespiteZeroStdDev() {
        List<Double> flatHistory = List.of(50.0, 50.0, 50.0, 50.0, 50.0);

        var check = service.checkMetric(ReadingMetric.LOAD_PERCENTAGE, 50.0, flatHistory);

        assertTrue(check.sufficientHistory());
        assertFalse(check.isAnomalous());
    }

    @Test
    void aFlatHistoryWithAnyDifferentNewValueIsAnomalousEvenThoughStdDevIsZero() {
        List<Double> flatHistory = List.of(50.0, 50.0, 50.0, 50.0, 50.0);

        var check = service.checkMetric(ReadingMetric.LOAD_PERCENTAGE, 55.0, flatHistory);

        assertTrue(check.sufficientHistory());
        assertTrue(check.isAnomalous());
    }

    @Test
    void checkAllMetricsAggregatesAnomaliesAcrossAllFourDimensions() {
        List<Double> tightVoltage = List.of(220.0, 220.1, 219.9, 220.2, 219.8);
        List<Double> tightCurrent = List.of(800.0, 801.0, 799.0, 800.5, 799.5);
        List<Double> tightLoad = List.of(60.0, 60.1, 59.9, 60.2, 59.8);
        List<Double> tightTemp = List.of(45.0, 45.1, 44.9, 45.2, 44.8);

        // Only voltage jumps far outside its own tight baseline; the other three stay normal.
        List<AnomalyDetectionService.StatisticalAnomaly> anomalies = service.checkAllMetrics(
            240.0, 800.0, 60.0, 45.0, tightVoltage, tightCurrent, tightLoad, tightTemp);

        assertEquals(1, anomalies.size());
        assertEquals(ReadingMetric.VOLTAGE, anomalies.get(0).metric());
    }

    @Test
    void largerSampleSizeStillComputesACorrectMeanAndFlagsOutliersConsistently() {
        List<Double> history = new ArrayList<>();
        for (int i = 0; i < 30; i++) {
            history.add(45.0 + (i % 2 == 0 ? 0.2 : -0.2)); // oscillates tightly around 45.0
        }

        var normalCheck = service.checkMetric(ReadingMetric.TEMPERATURE, 45.3, history);
        assertFalse(normalCheck.isAnomalous(), "a value inside the oscillation band should not be flagged");

        var anomalousCheck = service.checkMetric(ReadingMetric.TEMPERATURE, 60.0, history);
        assertTrue(anomalousCheck.isAnomalous(), "a large jump far outside the tight baseline should be flagged");
    }
}
