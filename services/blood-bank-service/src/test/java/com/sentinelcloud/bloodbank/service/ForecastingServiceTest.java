package com.sentinelcloud.bloodbank.service;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for the PROTOTYPE forecasting math itself (ForecastingService.predictNextPeriod)
 * — pure function, no Spring context, no database. See the class-level
 * Javadoc on ForecastingService for the required "not medically
 * validated" framing these tests are not meant to contradict: they
 * verify the arithmetic behaves sensibly, not that it is clinically
 * meaningful.
 */
class ForecastingServiceTest {

    @Test
    void emptyHistoryReturnsNull() {
        assertNull(ForecastingService.predictNextPeriod(List.of()));
    }

    @Test
    void singleDataPointIsReturnedAsIs() {
        assertEquals(10.0, ForecastingService.predictNextPeriod(List.of(10)));
    }

    @Test
    void flatHistoryPredictsTheSameValue() {
        Double prediction = ForecastingService.predictNextPeriod(List.of(20, 20, 20, 20));
        assertEquals(20.0, prediction, 0.01);
    }

    @Test
    void steadyUpwardTrendExtrapolatesForward() {
        // 10, 12, 14, 16, 18 -> next should be ~20
        Double prediction = ForecastingService.predictNextPeriod(List.of(10, 12, 14, 16, 18));
        assertEquals(20.0, prediction, 0.5);
    }

    @Test
    void steadyDownwardTrendExtrapolatesForward() {
        // 30, 25, 20, 15 -> next should be ~10
        Double prediction = ForecastingService.predictNextPeriod(List.of(30, 25, 20, 15));
        assertEquals(10.0, prediction, 0.5);
    }

    @Test
    void predictionNeverGoesNegativeEvenOnASteepDownwardTrend() {
        // A trend that would mathematically extrapolate below zero
        // must be clamped at 0 — demand can't be negative.
        Double prediction = ForecastingService.predictNextPeriod(List.of(10, 5, 0));
        assertTrue(prediction >= 0);
    }

    @Test
    void resultIsRoundedToOneDecimalPlace() {
        Double prediction = ForecastingService.predictNextPeriod(List.of(1, 2, 3));
        double scaled = prediction * 10;
        assertEquals(Math.round(scaled), scaled, 0.0001, "prediction should have at most 1 decimal place");
    }
}
