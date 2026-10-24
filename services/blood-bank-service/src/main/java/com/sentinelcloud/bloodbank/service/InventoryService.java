package com.sentinelcloud.bloodbank.service;

import com.sentinelcloud.bloodbank.domain.BloodType;
import com.sentinelcloud.bloodbank.dto.InventoryDtos.*;
import com.sentinelcloud.bloodbank.entity.BloodBank;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.exception.ConflictException;
import com.sentinelcloud.bloodbank.exception.NotFoundException;
import com.sentinelcloud.bloodbank.repository.BloodInventoryBatchRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class InventoryService {

    /**
     * Absolute-unit thresholds (not a percentage, unlike hospital-service's
     * bed-occupancy ratios) — blood inventory per type per bank is
     * typically a small count (single to low double digits of units),
     * where an absolute floor is the more meaningful signal than a
     * ratio of some larger total.
     */
    public static final int LOW_STOCK_WARNING_UNITS = 5;
    public static final int LOW_STOCK_CRITICAL_UNITS = 2;
    public static final int EXPIRY_WARNING_DAYS = 7;

    private final BloodInventoryBatchRepository batchRepository;

    public InventoryService(BloodInventoryBatchRepository batchRepository) {
        this.batchRepository = batchRepository;
    }

    /** Feature 1 — add inventory (a new donation batch). */
    @Transactional
    public BloodInventoryBatch addInventory(BloodBank bank, AddInventoryRequest req) {
        BloodType type = BloodType.parse(req.bloodType());
        BloodInventoryBatch batch = new BloodInventoryBatch(
            bank.getId(), type.group(), type.rh(), req.unitsAvailable(), req.collectionDate(), req.expiryDate()
        );
        return batchRepository.save(batch);
    }

    /** Feature 2 — update inventory (correct a batch's counts/dates). */
    @Transactional
    public BloodInventoryBatch updateInventory(UUID batchId, UpdateInventoryRequest req) {
        BloodInventoryBatch batch = batchRepository.findById(batchId)
            .orElseThrow(() -> new NotFoundException("Inventory batch not found."));

        // Phase 12: expired blood must never become usable stock again.
        if (req.expiryDate() != null && batch.isExpired(LocalDate.now()) && !req.expiryDate().equals(batch.getExpiryDate())) {
            throw new ConflictException("BATCH_EXPIRED", "This batch has expired; its expiry date can't be changed.");
        }
        LocalDate collection = req.collectionDate() != null ? req.collectionDate() : batch.getCollectionDate();
        LocalDate expiry = req.expiryDate() != null ? req.expiryDate() : batch.getExpiryDate();
        if (collection != null && expiry != null && !expiry.isAfter(collection)) {
            throw new IllegalArgumentException("Expiry date must be after the collection date.");
        }

        if (req.unitsAvailable() != null) batch.setUnitsAvailable(req.unitsAvailable());
        if (req.collectionDate() != null) batch.setCollectionDate(req.collectionDate());
        if (req.expiryDate() != null) batch.setExpiryDate(req.expiryDate());
        return batchRepository.save(batch);
    }

    public List<BloodInventoryBatch> listForBank(UUID bloodBankId) {
        return batchRepository.findByBloodBankId(bloodBankId);
    }

    public BloodInventoryBatch getOrThrow(UUID batchId) {
        return batchRepository.findById(batchId).orElseThrow(() -> new NotFoundException("Inventory batch not found."));
    }

    /**
     * Feature 6 — detect low inventory. Groups every bank's batches by
     * blood type, sums available units per (bank, type), and flags any
     * combination at or below the warning threshold. Expired batches
     * are excluded — they don't count as "available" stock at all.
     */
    public List<LowStockEntry> detectLowStock() {
        List<BloodInventoryBatch> all = batchRepository.findAll();
        LocalDate today = LocalDate.now();

        return all.stream()
            .filter(b -> !b.isExpired(today))
            .collect(Collectors.groupingBy(b -> new BankTypeKey(b.getBloodBankId(), b.getBloodGroup(), b.getRhFactor())))
            .entrySet().stream()
            .map(e -> {
                int totalAvailable = e.getValue().stream().mapToInt(BloodInventoryBatch::getUnitsAvailable).sum();
                BankTypeKey key = e.getKey();
                return new LowStockEntry(key.bloodBankId(), new BloodType(key.bloodGroup(), key.rhFactor()).display(), totalAvailable);
            })
            .filter(entry -> entry.unitsAvailable() <= LOW_STOCK_WARNING_UNITS)
            .collect(Collectors.toList());
    }

    /**
     * Same as {@link #detectLowStock()}, but also reports every blood type
     * a bank has NO usable batch of at all (0 units). Grouping batches
     * alone can't see those — a fully depleted type has no rows — and a
     * depleted type is the most critical shortage there is.
     */
    public List<LowStockEntry> detectLowStock(java.util.Collection<UUID> bloodBankIds) {
        java.util.Map<String, LowStockEntry> byKey = new java.util.LinkedHashMap<>();
        for (UUID bankId : bloodBankIds) {
            for (com.sentinelcloud.bloodbank.domain.BloodGroup g : com.sentinelcloud.bloodbank.domain.BloodGroup.values()) {
                for (com.sentinelcloud.bloodbank.domain.RhFactor rh : com.sentinelcloud.bloodbank.domain.RhFactor.values()) {
                    String type = new BloodType(g, rh).display();
                    byKey.put(bankId + "|" + type, new LowStockEntry(bankId, type, 0));
                }
            }
        }
        LocalDate today = LocalDate.now();
        for (BloodInventoryBatch b : batchRepository.findAll()) {
            if (b.isExpired(today) || !bloodBankIds.contains(b.getBloodBankId())) continue;
            String key = b.getBloodBankId() + "|" + new BloodType(b.getBloodGroup(), b.getRhFactor()).display();
            LowStockEntry e = byKey.get(key);
            byKey.put(key, new LowStockEntry(e.bloodBankId(), e.bloodType(), e.unitsAvailable() + b.getUnitsAvailable()));
        }
        return byKey.values().stream()
            .filter(entry -> entry.unitsAvailable() <= LOW_STOCK_WARNING_UNITS)
            .collect(Collectors.toList());
    }

    /** Feature 7 — detect units approaching expiry, within the given day window. */
    public List<BloodInventoryBatch> detectExpiringSoon(int withinDays) {
        LocalDate today = LocalDate.now();
        return batchRepository.findExpiringSoon(today, today.plusDays(withinDays));
    }

    public List<BloodInventoryBatch> detectExpired() {
        return batchRepository.findExpired(LocalDate.now());
    }

    /** All non-expired batches, across every blood bank — used to build the network-wide unitsByType summary. */
    public List<BloodInventoryBatch> listAllNonExpired() {
        LocalDate today = LocalDate.now();
        return batchRepository.findAll().stream().filter(b -> !b.isExpired(today)).collect(Collectors.toList());
    }

    private record BankTypeKey(UUID bloodBankId, com.sentinelcloud.bloodbank.domain.BloodGroup bloodGroup,
                                com.sentinelcloud.bloodbank.domain.RhFactor rhFactor) {}

    public record LowStockEntry(UUID bloodBankId, String bloodType, int unitsAvailable) {
        public boolean isCritical() { return unitsAvailable <= LOW_STOCK_CRITICAL_UNITS; }
    }
}
