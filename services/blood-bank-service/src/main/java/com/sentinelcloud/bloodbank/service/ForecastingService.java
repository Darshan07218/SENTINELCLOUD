package com.sentinelcloud.bloodbank.service;

import com.sentinelcloud.bloodbank.domain.BloodType;
import com.sentinelcloud.bloodbank.dto.MiscDtos.ForecastResponse;
import com.sentinelcloud.bloodbank.dto.MiscDtos.HistoricalPoint;
import com.sentinelcloud.bloodbank.entity.BloodDemandRecord;
import com.sentinelcloud.bloodbank.repository.BloodDemandRecordRepository;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.stream.Collectors;

/**
 * A BASIC, PROTOTYPE demand forecasting module — a simple least-squares
 * linear regression over historical (in this project, synthetic demo)
 * per-period demand, extrapolated one period forward. This is
 * intentionally the simplest model that produces a directionally
 * sensible trend line; it is NOT a clinically or statistically
 * validated forecasting system, has no confidence intervals, seasonal
 * decomposition, or outlier handling, and must not be treated as more
 * than a demonstration of "a forecasting endpoint exists and returns a
 * number derived from real historical data." Every API response this
 * service produces repeats this disclaimer explicitly (see
 * MiscDtos.ForecastResponse.DISCLAIMER) so it can never be silently
 * dropped by a downstream consumer.
 */
@Service
public class ForecastingService {

    private final BloodDemandRecordRepository demandRecordRepository;

    public ForecastingService(BloodDemandRecordRepository demandRecordRepository) {
        this.demandRecordRepository = demandRecordRepository;
    }

    public ForecastResponse forecast(String bloodTypeDisplay) {
        BloodType type = BloodType.parse(bloodTypeDisplay);
        List<BloodDemandRecord> records = demandRecordRepository
            .findByBloodGroupAndRhFactorOrderByPeriodStartAsc(type.group(), type.rh());

        List<HistoricalPoint> historical = records.stream()
            .map(r -> new HistoricalPoint(r.getPeriodStart(), r.getPeriodEnd(), r.getUnitsRequested()))
            .collect(Collectors.toList());

        List<Integer> series = records.stream().map(BloodDemandRecord::getUnitsRequested).collect(Collectors.toList());
        Double predicted = predictNextPeriod(series);

        return new ForecastResponse(type.display(), historical, predicted, "simple-linear-regression", ForecastResponse.DISCLAIMER);
    }

    /**
     * Pure function — no Spring, no I/O — so it's directly unit
     * testable without a database. Least-squares linear regression
     * over the series' own index (0, 1, 2, ...) as the independent
     * variable, extrapolated one step past the last index. Result is
     * floored at 0 (demand can't be negative) and rounded to one
     * decimal place.
     */
    public static Double predictNextPeriod(List<Integer> historicalUnits) {
        int n = historicalUnits.size();
        if (n == 0) return null; // no data — nothing to predict from
        if (n == 1) return (double) historicalUnits.get(0);

        double sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (int i = 0; i < n; i++) {
            double x = i;
            double y = historicalUnits.get(i);
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumXX += x * x;
        }
        double meanX = sumX / n;
        double meanY = sumY / n;
        double denominator = sumXX - n * meanX * meanX;

        double slope = denominator == 0 ? 0 : (sumXY - n * meanX * meanY) / denominator;
        double intercept = meanY - slope * meanX;

        double nextX = n; // one step past the last observed index
        double prediction = intercept + slope * nextX;

        double clamped = Math.max(0, prediction);
        return Math.round(clamped * 10.0) / 10.0;
    }
}
