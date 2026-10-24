package com.sentinelcloud.bloodbank.service;

import com.sentinelcloud.bloodbank.domain.BloodGroup;
import com.sentinelcloud.bloodbank.domain.RhFactor;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.repository.BloodInventoryBatchRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class InventoryServiceTest {

    private BloodInventoryBatchRepository batchRepository;
    private InventoryService inventoryService;

    private final UUID bankA = UUID.randomUUID();
    private final UUID bankB = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        batchRepository = mock(BloodInventoryBatchRepository.class);
        inventoryService = new InventoryService(batchRepository);
    }

    @Test
    void detectLowStockFlagsCombinationsAtOrBelowTheWarningThreshold() {
        LocalDate today = LocalDate.now();
        List<BloodInventoryBatch> all = List.of(
            new BloodInventoryBatch(bankA, BloodGroup.O, RhFactor.NEGATIVE, 3, today.minusDays(5), today.plusDays(30)), // low (<=5)
            new BloodInventoryBatch(bankA, BloodGroup.A, RhFactor.POSITIVE, 20, today.minusDays(5), today.plusDays(30)) // healthy
        );
        when(batchRepository.findAll()).thenReturn(all);

        List<InventoryService.LowStockEntry> lowStock = inventoryService.detectLowStock();

        assertEquals(1, lowStock.size());
        assertEquals("O-", lowStock.get(0).bloodType());
        assertEquals(3, lowStock.get(0).unitsAvailable());
    }

    @Test
    void detectLowStockSumsAcrossMultipleBatchesOfTheSameTypeAtTheSameBank() {
        LocalDate today = LocalDate.now();
        List<BloodInventoryBatch> all = List.of(
            new BloodInventoryBatch(bankA, BloodGroup.B, RhFactor.POSITIVE, 2, today.minusDays(10), today.plusDays(20)),
            new BloodInventoryBatch(bankA, BloodGroup.B, RhFactor.POSITIVE, 2, today.minusDays(5), today.plusDays(25))
        );
        when(batchRepository.findAll()).thenReturn(all);

        List<InventoryService.LowStockEntry> lowStock = inventoryService.detectLowStock();

        assertEquals(1, lowStock.size());
        assertEquals(4, lowStock.get(0).unitsAvailable()); // 2 + 2, summed
    }

    @Test
    void detectLowStockExcludesExpiredBatchesFromTheAvailableCount() {
        LocalDate today = LocalDate.now();
        List<BloodInventoryBatch> all = List.of(
            new BloodInventoryBatch(bankA, BloodGroup.AB, RhFactor.NEGATIVE, 10, today.minusDays(50), today.minusDays(1)) // expired
        );
        when(batchRepository.findAll()).thenReturn(all);

        List<InventoryService.LowStockEntry> lowStock = inventoryService.detectLowStock();

        assertTrue(lowStock.isEmpty(), "expired stock shouldn't count as available, low, or otherwise");
    }

    @Test
    void detectLowStockDoesNotFlagCombinationsAboveTheThreshold() {
        LocalDate today = LocalDate.now();
        List<BloodInventoryBatch> all = List.of(
            new BloodInventoryBatch(bankB, BloodGroup.O, RhFactor.POSITIVE, 50, today.minusDays(5), today.plusDays(30))
        );
        when(batchRepository.findAll()).thenReturn(all);

        assertTrue(inventoryService.detectLowStock().isEmpty());
    }

    @Test
    void lowStockEntryIsCriticalOnlyAtOrBelowTheCriticalThreshold() {
        var warning = new InventoryService.LowStockEntry(bankA, "A+", InventoryService.LOW_STOCK_WARNING_UNITS);
        var critical = new InventoryService.LowStockEntry(bankA, "A+", InventoryService.LOW_STOCK_CRITICAL_UNITS);

        assertFalse(warning.isCritical());
        assertTrue(critical.isCritical());
    }

    @Test
    void detectLowStockForBanksReportsFullyDepletedTypesAsZero() {
        LocalDate today = LocalDate.now();
        when(batchRepository.findAll()).thenReturn(List.of(
            new BloodInventoryBatch(bankA, BloodGroup.A, RhFactor.POSITIVE, 50, today.minusDays(3), today.plusDays(30))
        ));

        List<InventoryService.LowStockEntry> lowStock = inventoryService.detectLowStock(List.of(bankA));

        // 8 blood types; A+ is well stocked, the other 7 have no batch at all.
        assertEquals(7, lowStock.size());
        assertTrue(lowStock.stream().allMatch(e -> e.unitsAvailable() == 0 && e.isCritical()));
        assertTrue(lowStock.stream().noneMatch(e -> e.bloodType().equals("A+")));
    }
}
