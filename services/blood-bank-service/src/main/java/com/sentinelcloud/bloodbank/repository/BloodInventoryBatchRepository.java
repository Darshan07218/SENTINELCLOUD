package com.sentinelcloud.bloodbank.repository;

import com.sentinelcloud.bloodbank.domain.BloodGroup;
import com.sentinelcloud.bloodbank.domain.RhFactor;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface BloodInventoryBatchRepository extends JpaRepository<BloodInventoryBatch, UUID> {

    List<BloodInventoryBatch> findByBloodBankId(UUID bloodBankId);

    List<BloodInventoryBatch> findByBloodBankIdAndBloodGroupAndRhFactor(UUID bloodBankId, BloodGroup bloodGroup, RhFactor rhFactor);

    /**
     * FEFO (first-expiry-first-out) candidate selection for both
     * reservations and transfers: batches for a given blood bank +
     * type, unexpired as of the given date, with at least one unit
     * actually available (not already reserved), earliest expiry
     * first. See service/ReservationService.java and
     * service/TransferService.java.
     */
    @Query("""
        SELECT b FROM BloodInventoryBatch b
        WHERE b.bloodBankId = :bloodBankId
          AND b.bloodGroup = :bloodGroup
          AND b.rhFactor = :rhFactor
          AND b.expiryDate > :asOf
          AND b.unitsAvailable > 0
        ORDER BY b.expiryDate ASC
        """)
    List<BloodInventoryBatch> findAvailableFefo(@Param("bloodBankId") UUID bloodBankId,
                                                 @Param("bloodGroup") BloodGroup bloodGroup,
                                                 @Param("rhFactor") RhFactor rhFactor,
                                                 @Param("asOf") LocalDate asOf);

    /**
     * Same as {@link #findById(Object)} but with a pessimistic write
     * lock — used when mutating units_available so two concurrent
     * reservation requests against the same batch can't both read the
     * same "5 units available" and both succeed in reserving 4,
     * leaving the batch at -3. Combined with the entity's @Version
     * column, this is defense in depth: the lock prevents the race
     * outright, the version column would catch it even if the lock
     * were ever bypassed.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT b FROM BloodInventoryBatch b WHERE b.id = :id")
    Optional<BloodInventoryBatch> findByIdForUpdate(@Param("id") UUID id);

    @Query("""
        SELECT b FROM BloodInventoryBatch b
        WHERE b.expiryDate > :today AND b.expiryDate <= :cutoff AND b.unitsAvailable > 0
        ORDER BY b.expiryDate ASC
        """)
    List<BloodInventoryBatch> findExpiringSoon(@Param("today") LocalDate today, @Param("cutoff") LocalDate cutoff);

    @Query("SELECT b FROM BloodInventoryBatch b WHERE b.expiryDate <= :today")
    List<BloodInventoryBatch> findExpired(@Param("today") LocalDate today);

    @Query("""
        SELECT COALESCE(SUM(b.unitsAvailable), 0) FROM BloodInventoryBatch b
        WHERE b.bloodBankId = :bloodBankId AND b.bloodGroup = :bloodGroup AND b.rhFactor = :rhFactor
          AND b.expiryDate > :asOf
        """)
    Integer sumAvailableUnits(@Param("bloodBankId") UUID bloodBankId, @Param("bloodGroup") BloodGroup bloodGroup,
                              @Param("rhFactor") RhFactor rhFactor, @Param("asOf") LocalDate asOf);
}
