package com.sentinelcloud.bloodbank.service;

import com.sentinelcloud.bloodbank.domain.BloodType;
import com.sentinelcloud.bloodbank.domain.ReservationStatus;
import com.sentinelcloud.bloodbank.dto.ReservationDtos.CreateReservationRequest;
import com.sentinelcloud.bloodbank.entity.BloodBank;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.entity.BloodReservation;
import com.sentinelcloud.bloodbank.exception.ConflictException;
import com.sentinelcloud.bloodbank.exception.NotFoundException;
import com.sentinelcloud.bloodbank.repository.BloodInventoryBatchRepository;
import com.sentinelcloud.bloodbank.repository.BloodReservationRepository;
import com.sentinelcloud.bloodbank.security.AuthenticatedUser;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** Feature 3 (reserve blood) and feature 4 (release reservation). */
@Service
public class ReservationService {

    private final BloodInventoryBatchRepository batchRepository;
    private final BloodReservationRepository reservationRepository;

    public ReservationService(BloodInventoryBatchRepository batchRepository, BloodReservationRepository reservationRepository) {
        this.batchRepository = batchRepository;
        this.reservationRepository = reservationRepository;
    }

    /**
     * Reserves from exactly one batch, chosen FEFO (earliest expiry
     * first among batches with enough available units). If no single
     * batch can cover the full request, the reservation is rejected
     * rather than split across multiple batches — see the rationale in
     * migration V2__create_reservations.sql and
     * docs/PHASE-5-BLOOD-BANK.md. Each candidate is re-fetched with a
     * pessimistic write lock immediately before checking/mutating it,
     * so two concurrent reservation requests against the same batch
     * can't both read "5 available" and both succeed reserving 4.
     */
    @Transactional
    public BloodReservation reserveBlood(UUID bloodBankId, CreateReservationRequest req, UUID reservedByUserId) {
        BloodType type = BloodType.parse(req.bloodType());
        LocalDate today = LocalDate.now();

        List<BloodInventoryBatch> candidates = batchRepository.findAvailableFefo(bloodBankId, type.group(), type.rh(), today);

        for (BloodInventoryBatch candidate : candidates) {
            BloodInventoryBatch locked = batchRepository.findByIdForUpdate(candidate.getId())
                .orElseThrow(() -> new NotFoundException("Inventory batch not found."));

            if (locked.isExpired(today)) continue; // may have expired between the two reads
            if (locked.getUnitsAvailable() >= req.unitsRequested()) {
                locked.setUnitsAvailable(locked.getUnitsAvailable() - req.unitsRequested());
                locked.setReservedUnits(locked.getReservedUnits() + req.unitsRequested());
                batchRepository.save(locked);

                BloodReservation reservation = new BloodReservation(
                    locked.getId(), req.hospitalId(), req.unitsRequested(), req.notes(), reservedByUserId
                );
                return reservationRepository.save(reservation);
            }
        }

        int totalAcrossBatches = candidates.stream().mapToInt(BloodInventoryBatch::getUnitsAvailable).sum();
        throw new ConflictException(
            "INSUFFICIENT_INVENTORY",
            String.format(
                "No single batch of %s has %d available units. Total across all batches at this bank is %d " +
                "— this service reserves from one batch at a time (see docs).",
                type.display(), req.unitsRequested(), totalAcrossBatches
            )
        );
    }

    @Transactional
    public BloodReservation releaseReservation(UUID reservationId) {
        // Locked read first (and the only read of this row in the
        // transaction, so the entity can't be a stale cached copy).
        BloodReservation reservation = reservationRepository.findByIdForUpdate(reservationId)
            .orElseThrow(() -> new NotFoundException("Reservation not found."));

        if (reservation.getStatus() != ReservationStatus.ACTIVE) {
            throw new ConflictException("RESERVATION_NOT_ACTIVE",
                "Reservation is " + reservation.getStatus() + ", not ACTIVE — it cannot be released.");
        }

        BloodInventoryBatch batch = batchRepository.findByIdForUpdate(reservation.getBatchId())
            .orElseThrow(() -> new NotFoundException("Inventory batch not found."));

        batch.setReservedUnits(Math.max(0, batch.getReservedUnits() - reservation.getUnitsReserved()));
        // Units only go back into the available pool if the batch
        // hasn't expired in the meantime — an expired batch's units
        // are no longer usable regardless of reservation status.
        if (!batch.isExpired(LocalDate.now())) {
            batch.setUnitsAvailable(batch.getUnitsAvailable() + reservation.getUnitsReserved());
        }
        batchRepository.save(batch);

        reservation.release();
        return reservationRepository.save(reservation);
    }

    public BloodReservation getOrThrow(UUID reservationId) {
        return reservationRepository.findById(reservationId)
            .orElseThrow(() -> new NotFoundException("Reservation not found."));
    }

    /**
     * Phase 12: who may release (cancel) a reservation. Before, ANY
     * HOSPITAL_ADMIN could release ANY reservation — e.g. free up blood
     * another hospital had set aside for surgery. Now only:
     * a SYSTEM_ADMIN, the admin who made the reservation, or an admin of
     * the blood bank that holds the reserved batch.
     */
    public static boolean canRelease(BloodReservation reservation, BloodBank bankOfBatch, AuthenticatedUser caller) {
        if (caller == null) return false;
        if ("SYSTEM_ADMIN".equals(caller.role())) return true;
        if (!"HOSPITAL_ADMIN".equals(caller.role())) return false;
        if (caller.id().equals(reservation.getReservedByUserId())) return true;
        return bankOfBatch != null && caller.id().equals(bankOfBatch.getManagedByUserId());
    }

    public List<BloodReservation> listActive() {
        return reservationRepository.findByStatus(ReservationStatus.ACTIVE);
    }
}
