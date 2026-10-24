package com.sentinelcloud.bloodbank.dto;

import jakarta.validation.constraints.*;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

public class MiscDtos {

    public record TransferInventoryRequest(
        @NotNull UUID toBloodBankId,
        @NotBlank @Pattern(regexp = "^(A|B|AB|O)[+-]$") String bloodType,
        @NotNull @Min(1) @Max(10000) Integer units
    ) {}

    public record TransferResponse(
        UUID fromBloodBankId, UUID toBloodBankId, String bloodType, Integer unitsTransferred,
        List<UUID> sourceBatchIdsDrawnFrom, List<UUID> destinationBatchIds
    ) {}

    public enum AlertSeverity { WARNING, CRITICAL }

    public record ShortageAlert(
        AlertSeverity severity, String type, UUID bloodBankId, String bloodBankName,
        String bloodType, String message, Integer unitsAvailable, LocalDate expiryDate
    ) {}

    /**
     * PROTOTYPE ONLY. See service/ForecastingService.java — this
     * number comes from a simple least-squares linear regression over
     * demo/synthetic historical data, and the disclaimer is always
     * included in the response so no consumer of this API can miss it.
     */
    public record ForecastResponse(
        String bloodType, List<HistoricalPoint> historicalDemand, Double predictedNextPeriodUnits,
        String method, String disclaimer
    ) {
        public static final String DISCLAIMER =
            "PROTOTYPE FORECAST - for demonstration purposes only. This is a simple statistical model over " +
            "synthetic demo data. It is NOT medically validated and must NOT be used for real clinical, " +
            "operational, or inventory-procurement decisions.";
    }

    public record HistoricalPoint(LocalDate periodStart, LocalDate periodEnd, Integer unitsRequested) {}
}
