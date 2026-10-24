package com.sentinelcloud.bloodbank.dto;

import com.sentinelcloud.bloodbank.entity.BloodReservation;
import jakarta.validation.constraints.*;

import java.time.Instant;
import java.util.UUID;

public class ReservationDtos {

    public record CreateReservationRequest(
        @NotBlank @Pattern(regexp = "^(A|B|AB|O)[+-]$", message = "Must be one of A+, A-, B+, B-, AB+, AB-, O+, O-") String bloodType,
        @NotNull @Min(1) @Max(500) Integer unitsRequested,
        @NotNull UUID hospitalId,
        @Size(max = 500) String notes
    ) {}

    public record ReservationResponse(
        UUID id, UUID batchId, UUID hospitalId, Integer unitsReserved, String status, String notes,
        UUID reservedByUserId, Instant reservedAt, Instant releasedAt, Instant fulfilledAt
    ) {
        public static ReservationResponse of(BloodReservation r) {
            return new ReservationResponse(r.getId(), r.getBatchId(), r.getHospitalId(), r.getUnitsReserved(),
                r.getStatus().name(), r.getNotes(), r.getReservedByUserId(), r.getReservedAt(),
                r.getReleasedAt(), r.getFulfilledAt());
        }
    }
}
