package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.service.TransformerRiskForecaster.RiskForecast;
import com.sentinelcloud.power.service.TransformerRiskForecaster.Sample;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.function.IntToDoubleFunction;

import static org.junit.jupiter.api.Assertions.*;

class TransformerRiskForecasterTest {

    private static final Instant NOW = Instant.parse("2026-10-25T12:00:00Z");

    /** One reading per hour for the last `hours` hours (oldest first); f(hoursAgo). */
    private static List<Sample> hourly(int hours, IntToDoubleFunction load, IntToDoubleFunction temp) {
        List<Sample> samples = new ArrayList<>();
        for (int k = hours; k >= 0; k--) {
            samples.add(new Sample(NOW.minus(k, ChronoUnit.HOURS), load.applyAsDouble(k), temp.applyAsDouble(k), false));
        }
        return samples;
    }

    @Test
    void steadyHealthyTransformerIsLowRiskWithFlatProjection() {
        RiskForecast f = TransformerRiskForecaster.forecast(hourly(48, k -> 55, k -> 40), InfraStatus.NORMAL, 0, 24);

        assertEquals("OK", f.status());
        assertEquals("LOW", f.level());
        assertTrue(f.score() < 25, "score " + f.score());
        assertEquals(0.0, f.temperature().slopePerHour(), 1e-9);
        assertNull(f.temperature().hoursToCritical());
        assertEquals(25, f.projection().size()); // 0..24
        assertEquals(40.0, f.projection().get(24).temperatureCelsius(), 1e-9);
        assertTrue(f.reasons().get(0).contains("steady"));
    }

    @Test
    void risingTemperatureGetsAnEtaToCriticalAndAtLeastHighRisk() {
        // +1 °C per hour, now at 75 °C: 85 °C critical in about 10 h.
        RiskForecast f = TransformerRiskForecaster.forecast(hourly(24, k -> 70, k -> 75 - k), InfraStatus.WARNING, 0, 24);

        assertEquals(1.0, f.temperature().slopePerHour(), 1e-6);
        assertEquals(10.0, f.temperature().hoursToCritical(), 0.05);
        assertEquals(99.0, f.temperature().projected(), 0.05); // 75 + 1 × 24
        assertTrue(List.of("HIGH", "CRITICAL").contains(f.level()), f.level());
        assertTrue(f.reasons().stream().anyMatch(r -> r.startsWith("Temperature rising")), f.reasons().toString());
    }

    @Test
    void criticalWithinSixHoursIsCritical() {
        // Load +2 %/h, now 92 %: 100 % in 4 h.
        RiskForecast f = TransformerRiskForecaster.forecast(hourly(12, k -> 92 - 2 * k, k -> 50), InfraStatus.WARNING, 0, 24);

        assertEquals(4.0, f.load().hoursToCritical(), 0.05);
        assertEquals("CRITICAL", f.level());
    }

    @Test
    void neverExtrapolatesFurtherThanTheHistoryBehindIt() {
        // Two hours of a steep rise must not be projected over 24 hours.
        RiskForecast f = TransformerRiskForecaster.forecast(hourly(2, k -> 50, k -> 60 - 5 * k), InfraStatus.NORMAL, 0, 24);

        assertEquals(2.0, f.historyHours(), 1e-9);
        assertEquals(70.0, f.temperature().projected(), 0.05); // 60 + 5 × 2, not 60 + 5 × 24
        assertNull(f.temperature().hoursToCritical()); // 85 °C would take 5 h: beyond the 2 h it can see
        assertEquals(70.0, f.projection().get(24).temperatureCelsius(), 0.05);
    }

    @Test
    void alreadyAboveCriticalHasZeroHoursToCritical() {
        RiskForecast f = TransformerRiskForecaster.forecast(hourly(24, k -> 108, k -> 91), InfraStatus.CRITICAL, 0, 24);

        assertEquals(0.0, f.load().hoursToCritical());
        assertEquals(0.0, f.temperature().hoursToCritical());
        assertEquals("CRITICAL", f.level());
        assertTrue(f.reasons().stream().anyMatch(r -> r.contains("at or above critical")));
    }

    @Test
    void failedTransformerScoresHundred() {
        RiskForecast f = TransformerRiskForecaster.forecast(hourly(24, k -> 40, k -> 35), InfraStatus.FAILED, 1, 24);

        assertEquals(100, f.score());
        assertEquals("CRITICAL", f.level());
        assertEquals("Currently FAILED", f.reasons().get(0));
    }

    @Test
    void recentFailuresAndAnomaliesRaiseTheScore() {
        List<Sample> calm = hourly(24, k -> 55, k -> 40);
        List<Sample> noisy = new ArrayList<>();
        for (int i = 0; i < calm.size(); i++) {
            Sample s = calm.get(i);
            noisy.add(new Sample(s.at(), s.loadPercentage(), s.temperatureCelsius(), i % 2 == 0));
        }
        int base = TransformerRiskForecaster.forecast(calm, InfraStatus.NORMAL, 0, 24).score();
        RiskForecast worse = TransformerRiskForecaster.forecast(noisy, InfraStatus.NORMAL, 3, 24);

        assertEquals(base + 15 + 5, worse.score(), 1); // all three failures (15) + ~half anomalous (≈5)
        assertTrue(worse.reasons().stream().anyMatch(r -> r.contains("3 failure(s)")));
    }

    @Test
    void tooLittleHistoryUsesCurrentValuesOnly() {
        List<Sample> two = hourly(1, k -> 108, k -> 91); // 2 readings
        RiskForecast f = TransformerRiskForecaster.forecast(two, InfraStatus.CRITICAL, 0, 24);

        assertEquals("INSUFFICIENT_DATA", f.status());
        assertEquals(0.0, f.load().slopePerHour());
        assertEquals("CRITICAL", f.level()); // still: it is above critical right now
    }

    @Test
    void noTelemetryAtAll() {
        RiskForecast f = TransformerRiskForecaster.forecast(List.of(), InfraStatus.NORMAL, 0, 24);

        assertEquals("INSUFFICIENT_DATA", f.status());
        assertEquals(0, f.score());
        assertEquals("LOW", f.level());
        assertNull(f.load());
        assertTrue(f.projection().isEmpty());
    }

    @Test
    void slopeIsOrdinaryLeastSquares() {
        assertEquals(2.0, TransformerRiskForecaster.slope(new double[] {0, 1, 2, 3}, new double[] {1, 3, 5, 7}), 1e-9);
        assertEquals(0.0, TransformerRiskForecaster.slope(new double[] {5, 5, 5}, new double[] {1, 2, 3}), 1e-9);
    }

    @Test
    void levelThresholds() {
        assertEquals("LOW", TransformerRiskForecaster.levelFor(24, null, 24));
        assertEquals("MODERATE", TransformerRiskForecaster.levelFor(25, null, 24));
        assertEquals("HIGH", TransformerRiskForecaster.levelFor(50, null, 24));
        assertEquals("CRITICAL", TransformerRiskForecaster.levelFor(75, null, 24));
        assertEquals("HIGH", TransformerRiskForecaster.levelFor(10, 20.0, 24)); // crosses within the horizon
        assertEquals("CRITICAL", TransformerRiskForecaster.levelFor(10, 6.0, 24));
    }
}
