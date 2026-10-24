package com.sentinelcloud.bloodbank.dto;

import com.sentinelcloud.bloodbank.domain.BloodType;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import jakarta.validation.constraints.*;

import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

public class InventoryDtos {

    public record AddInventoryRequest(
        @NotBlank @Pattern(regexp = "^(A|B|AB|O)[+-]$", message = "Must be one of A+, A-, B+, B-, AB+, AB-, O+, O-") String bloodType,
        @NotNull @Min(1) @Max(10000) Integer unitsAvailable,
        @NotNull @PastOrPresent LocalDate collectionDate,
        @NotNull @Future LocalDate expiryDate
    ) {}

    public record UpdateInventoryRequest(
        @Min(0) @Max(10000) Integer unitsAvailable,
        @PastOrPresent LocalDate collectionDate,
        // Phase 12: a correction may move the expiry date, but never into
        // the past; InventoryService also refuses to re-date a batch that
        // has already expired (that would put expired blood back in stock).
        @FutureOrPresent LocalDate expiryDate
    ) {}

    public record InventoryBatchResponse(
        UUID id, UUID bloodBankId, String bloodType, Integer unitsAvailable, Integer reservedUnits,
        LocalDate collectionDate, LocalDate expiryDate, boolean expired, Instant createdAt, Instant updatedAt
    ) {
        public static InventoryBatchResponse of(BloodInventoryBatch batch) {
            BloodType type = new BloodType(batch.getBloodGroup(), batch.getRhFactor());
            return new InventoryBatchResponse(
                batch.getId(), batch.getBloodBankId(), type.display(),
                batch.getUnitsAvailable(), batch.getReservedUnits(),
                batch.getCollectionDate(), batch.getExpiryDate(),
                batch.isExpired(LocalDate.now()),
                batch.getCreatedAt(), batch.getUpdatedAt()
            );
        }
    }
}
