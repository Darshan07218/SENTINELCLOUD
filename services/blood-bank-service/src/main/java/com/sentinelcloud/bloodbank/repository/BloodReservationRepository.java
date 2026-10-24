package com.sentinelcloud.bloodbank.repository;

import com.sentinelcloud.bloodbank.domain.ReservationStatus;
import com.sentinelcloud.bloodbank.entity.BloodReservation;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface BloodReservationRepository extends JpaRepository<BloodReservation, UUID> {
    List<BloodReservation> findByStatus(ReservationStatus status);
    List<BloodReservation> findByHospitalId(UUID hospitalId);
    List<BloodReservation> findByBatchId(UUID batchId);

    /**
     * Row-locks the reservation (SELECT ... FOR UPDATE). Two concurrent
     * releases of the same reservation serialise here, so the second one
     * sees RELEASED and gets a 409 instead of crediting the units twice.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT r FROM BloodReservation r WHERE r.id = :id")
    Optional<BloodReservation> findByIdForUpdate(@Param("id") UUID id);
}
