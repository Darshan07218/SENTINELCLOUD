package com.sentinelcloud.bloodbank.service;

import com.sentinelcloud.bloodbank.domain.BloodType;
import com.sentinelcloud.bloodbank.dto.MiscDtos.TransferInventoryRequest;
import com.sentinelcloud.bloodbank.dto.MiscDtos.TransferResponse;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.exception.ConflictException;
import com.sentinelcloud.bloodbank.exception.NotFoundException;
import com.sentinelcloud.bloodbank.repository.BloodBankRepository;
import com.sentinelcloud.bloodbank.repository.BloodInventoryBatchRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Feature 5 — transfer inventory between blood banks. Unlike a
 * reservation (which deliberately draws from exactly one batch — see
 * ReservationService), a transfer may draw from several source batches
 * FEFO to fulfill the requested quantity, since there's no reservation
 * record simplicity to preserve here — just moving physical units. One
 * new destination batch is created per source batch drawn from, each
 * carrying over that source batch's original collectionDate and
 * expiryDate: physically moving blood between facilities doesn't reset
 * its biological expiry, and preserving the original collection date
 * per lot keeps donation traceability intact after the move.
 */
@Service
public class TransferService {

    private final BloodBankRepository bloodBankRepository;
    private final BloodInventoryBatchRepository batchRepository;

    public TransferService(BloodBankRepository bloodBankRepository, BloodInventoryBatchRepository batchRepository) {
        this.bloodBankRepository = bloodBankRepository;
        this.batchRepository = batchRepository;
    }

    @Transactional
    public TransferResponse transfer(UUID fromBloodBankId, TransferInventoryRequest req) {
        if (fromBloodBankId.equals(req.toBloodBankId())) {
            throw new ConflictException("INVALID_TRANSFER", "Source and destination blood bank cannot be the same.");
        }
        if (!bloodBankRepository.existsById(req.toBloodBankId())) {
            throw new NotFoundException("Destination blood bank not found.");
        }

        BloodType type = BloodType.parse(req.bloodType());
        LocalDate today = LocalDate.now();

        List<BloodInventoryBatch> candidates = batchRepository.findAvailableFefo(fromBloodBankId, type.group(), type.rh(), today);

        int remaining = req.units();
        List<UUID> sourceBatchIds = new ArrayList<>();
        List<UUID> destinationBatchIds = new ArrayList<>();

        for (BloodInventoryBatch candidate : candidates) {
            if (remaining <= 0) break;

            BloodInventoryBatch locked = batchRepository.findByIdForUpdate(candidate.getId())
                .orElseThrow(() -> new NotFoundException("Inventory batch not found."));
            if (locked.isExpired(today) || locked.getUnitsAvailable() <= 0) continue;

            int take = Math.min(remaining, locked.getUnitsAvailable());
            locked.setUnitsAvailable(locked.getUnitsAvailable() - take);
            batchRepository.save(locked);
            sourceBatchIds.add(locked.getId());

            BloodInventoryBatch destinationBatch = new BloodInventoryBatch(
                req.toBloodBankId(), type.group(), type.rh(), take, locked.getCollectionDate(), locked.getExpiryDate()
            );
            batchRepository.save(destinationBatch);
            destinationBatchIds.add(destinationBatch.getId());

            remaining -= take;
        }

        if (remaining > 0) {
            // Since this whole method runs in one @Transactional
            // block, throwing here rolls back every save() above —
            // either the full requested amount moves, or nothing does.
            int totalAvailable = req.units() - remaining;
            throw new ConflictException(
                "INSUFFICIENT_INVENTORY",
                String.format("Only %d units of %s available at the source blood bank (requested %d).",
                    totalAvailable, type.display(), req.units())
            );
        }

        return new TransferResponse(fromBloodBankId, req.toBloodBankId(), type.display(), req.units(), sourceBatchIds, destinationBatchIds);
    }
}
