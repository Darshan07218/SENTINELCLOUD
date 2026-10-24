package com.sentinelcloud.power.dto;

import com.sentinelcloud.power.entity.Substation;
import jakarta.validation.constraints.*;

import java.time.Instant;
import java.util.UUID;

public class SubstationDtos {

    public record CreateSubstationRequest(
        @NotBlank @Size(min = 2, max = 160) String name,
        @NotBlank @Size(min = 5, max = 500) String address,
        @NotNull @DecimalMin("-90") @DecimalMax("90") Double latitude,
        @NotNull @DecimalMin("-180") @DecimalMax("180") Double longitude,
        @Size(max = 120) String gridZone
    ) {}

    public record UpdateSubstationRequest(
        @Size(min = 2, max = 160) String name,
        @Size(min = 5, max = 500) String address,
        @DecimalMin("-90") @DecimalMax("90") Double latitude,
        @DecimalMin("-180") @DecimalMax("180") Double longitude,
        @Size(max = 120) String gridZone
    ) {}

    public record SubstationResponse(
        UUID id, String name, String address, Double latitude, Double longitude, String gridZone,
        UUID managedByUserId, Double distanceKm, Instant createdAt, Instant updatedAt
    ) {
        public static SubstationResponse of(Substation s, Double distanceKm) {
            return new SubstationResponse(s.getId(), s.getName(), s.getAddress(), s.getLatitude(), s.getLongitude(),
                s.getGridZone(), s.getManagedByUserId(), distanceKm, s.getCreatedAt(), s.getUpdatedAt());
        }
    }
}
