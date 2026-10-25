package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.InfraStatus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Phase 22: backtest of the transformer projection (TransformerRiskForecaster)
 * on REAL transformer telemetry (docs/PHASE-22-VALIDATION.md §4).
 *
 * Data: ETDataset "ETTh1" (Zhou et al., AAAI 2021, https://github.com/zhouhaoyi/ETDataset):
 * two years of hourly oil temperature (OT) and loads from an electricity
 * transformer. Not committed; runs only when ETT_CSV points to the file:
 *
 *   ETT_CSV=/path/ETTh1.csv mvn -Dtest=RiskForecasterBacktest test
 *
 * The forecaster gets what the live service gives it (the last 7 days of
 * hourly readings) and projects the temperature 1, 6, 12 and 24 h ahead;
 * every 24 h, the projection is compared with what happened and with
 * persistence ("no change"), the standard naive baseline. Only temperature is
 * scored: ETT's loads are in MW, not % of rating. Results print to stdout
 * and, if ETT_RESULTS is set, are written there as JSON.
 */
class RiskForecasterBacktest {

    private static final int WINDOW = 168;
    private static final int[] HORIZONS = {1, 6, 12, 24};

    @Test
    @EnabledIfEnvironmentVariable(named = "ETT_CSV", matches = ".+")
    void projectionVersusPersistenceOnRealTransformerData() throws Exception {
        List<String> lines = Files.readAllLines(Path.of(System.getenv("ETT_CSV")));
        DateTimeFormatter fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
        List<Instant> times = new ArrayList<>();
        List<Double> ot = new ArrayList<>();
        for (String line : lines.subList(1, lines.size())) {
            String[] f = line.split(",");
            times.add(LocalDateTime.parse(f[0], fmt).toInstant(ZoneOffset.UTC));
            ot.add(Double.parseDouble(f[7]));
        }

        Map<Integer, double[]> sums = new LinkedHashMap<>(); // h -> {absProjection, absPersistence, n}
        for (int h : HORIZONS) sums.put(h, new double[3]);
        int origins = 0;
        for (int t = WINDOW; t + 24 < ot.size(); t += 24) {
            List<TransformerRiskForecaster.Sample> samples = new ArrayList<>();
            for (int i = t - WINDOW; i < t; i++) samples.add(new TransformerRiskForecaster.Sample(times.get(i), 50.0, ot.get(i), false));
            var forecast = TransformerRiskForecaster.forecast(samples, InfraStatus.NORMAL, 0, 24);
            double last = ot.get(t - 1);
            for (int h : HORIZONS) {
                double projected = forecast.projection().get(h).temperatureCelsius();
                double actual = ot.get(t - 1 + h);
                double[] s = sums.get(h);
                s[0] += Math.abs(projected - actual);
                s[1] += Math.abs(last - actual);
                s[2]++;
            }
            origins++;
        }

        StringBuilder json = new StringBuilder("{\n  \"generatedBy\": \"RiskForecasterBacktest (power-service tests)\",\n  \"data\": \"ETDataset ETTh1, hourly oil temperature\",\n  \"origins\": " + origins + ",\n  \"horizons\": {");
        System.out.printf("ETTh1: %d hourly readings, %d forecast origins (every 24 h, 168 h window)%n", ot.size(), origins);
        boolean first = true;
        for (int h : HORIZONS) {
            double[] s = sums.get(h);
            double maeProjection = s[0] / s[2];
            double maePersistence = s[1] / s[2];
            double skill = 1 - maeProjection / maePersistence;
            System.out.printf("  +%2d h: MAE projection %.2f °C vs persistence %.2f °C, skill %.2f%n", h, maeProjection, maePersistence, skill);
            json.append(first ? "" : ",").append(String.format("%n    \"%d\": {\"maeProjection\": %.3f, \"maePersistence\": %.3f, \"skill\": %.3f}", h, maeProjection, maePersistence, skill));
            first = false;
        }
        json.append("\n  }\n}\n");
        String out = System.getenv("ETT_RESULTS");
        if (out != null && !out.isBlank()) Files.writeString(Path.of(out), json.toString());
    }
}
