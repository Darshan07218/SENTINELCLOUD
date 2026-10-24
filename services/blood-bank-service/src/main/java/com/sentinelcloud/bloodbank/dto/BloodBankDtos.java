package com.sentinelcloud.bloodbank.dto;

import jakarta.validation.constraints.*;

import java.time.Instant;
import java.util.UUID;

public class BloodBankDtos {

    public record CreateBloodBankRequest(
        @NotBlank @Size(min = 2, max = 160) String name,
        @NotBlank @Size(min = 5, max = 500) String address,
        @NotNull @DecimalMin("-90") @DecimalMax("90") Double latitude,
        @NotNull @DecimalMin("-180") @DecimalMax("180") Double longitude,
        @NotBlank @Pattern(regexp = "^[0-9+()\\-.\\s]{7,32}$", message = "Must be a valid phone number") String contactPhone
    ) {}

    public record UpdateBloodBankRequest(
        @Size(min = 2, max = 160) String name,
        @Size(min = 5, max = 500) String address,
        @DecimalMin("-90") @DecimalMax("90") Double latitude,
        @DecimalMin("-180") @DecimalMax("180") Double longitude,
        @Pattern(regexp = "^[0-9+()\\-.\\s]{7,32}$", message = "Must be a valid phone number") String contactPhone
    ) {}

    public record BloodBankResponse(
        UUID id, String name, String address, Double latitude, Double longitude,
        String contactPhone, UUID managedByUserId, Double distanceKm,
        Instant createdAt, Instant updatedAt
    ) {
        public static BloodBankResponse of(com.sentinelcloud.bloodbank.entity.BloodBank b, Double distanceKm) {
            return new BloodBankResponse(b.getId(), b.getName(), b.getAddress(), b.getLatitude(), b.getLongitude(),
                b.getContactPhone(), b.getManagedByUserId(), distanceKm, b.getCreatedAt(), b.getUpdatedAt());
        }
    }
}
