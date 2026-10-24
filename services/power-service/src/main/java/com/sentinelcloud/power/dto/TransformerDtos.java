package com.sentinelcloud.power.dto;

import com.sentinelcloud.power.entity.Transformer;
import jakarta.validation.constraints.*;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

public class TransformerDtos {

    public record CreateTransformerRequest(
        @NotBlank @Size(min = 1, max = 80) String code,
        @NotBlank @Size(min = 2, max = 160) String name,
        @NotNull @Positive Double ratedVoltageKv,
        @NotNull @Positive Double ratedCurrentAmps,
        @PastOrPresent LocalDate lastInspectionDate
    ) {}

    public record UpdateTransformerRequest(
        @Size(min = 2, max = 160) String name,
        @Positive Double ratedVoltageKv,
        @Positive Double ratedCurrentAmps,
        @PastOrPresent LocalDate lastInspectionDate
    ) {}

    public record TelemetryRequest(
        // Phase 12: physically plausible upper bounds, so one bogus reading
        // can't wreck the statistical baseline anomaly detection relies on.
        @NotNull @PositiveOrZero @DecimalMax("1000000") Double voltage,
        @NotNull @PositiveOrZero @DecimalMax("100000") Double currentAmps,
        @NotNull @PositiveOrZero @DecimalMax("500") Double loadPercentage,
        @NotNull @DecimalMin("-80") @DecimalMax("300") Double temperatureCelsius,
        Instant recordedAt
    ) {}

    public record TransformerResponse(
        UUID id, UUID substationId, String code, String name,
        Double ratedVoltageKv, Double ratedCurrentAmps, String status, LocalDate lastInspectionDate,
        Double lastVoltage, Double lastCurrentAmps, Double lastLoadPercentage, Double lastTemperatureCelsius,
        Instant lastReadingAt, Instant createdAt, Instant updatedAt
    ) {
        public static TransformerResponse of(Transformer t) {
            return new TransformerResponse(t.getId(), t.getSubstationId(), t.getCode(), t.getName(),
                t.getRatedVoltageKv(), t.getRatedCurrentAmps(), t.getStatus().name(), t.getLastInspectionDate(),
                t.getLastVoltage(), t.getLastCurrentAmps(), t.getLastLoadPercentage(), t.getLastTemperatureCelsius(),
                t.getLastReadingAt(), t.getCreatedAt(), t.getUpdatedAt());
        }
    }

    public record SetStatusRequest(
        @NotBlank @Pattern(regexp = "^(NORMAL|WARNING|CRITICAL|FAILED)$") String status,
        @NotBlank @Size(max = 500) String reason
    ) {}
}
