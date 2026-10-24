package com.sentinelcloud.bloodbank.controller;

import jakarta.validation.constraints.*;
import com.sentinelcloud.bloodbank.dto.BloodBankDtos.*;
import com.sentinelcloud.bloodbank.dto.InventoryDtos.*;
import com.sentinelcloud.bloodbank.dto.MiscDtos.TransferInventoryRequest;
import com.sentinelcloud.bloodbank.dto.MiscDtos.TransferResponse;
import com.sentinelcloud.bloodbank.entity.BloodBank;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.security.AuthenticatedUser;
import com.sentinelcloud.bloodbank.service.BloodBankService;
import com.sentinelcloud.bloodbank.service.InventoryService;
import com.sentinelcloud.bloodbank.service.TransferService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
public class BloodBankController {

    private final BloodBankService bloodBankService;
    private final InventoryService inventoryService;
    private final TransferService transferService;

    public BloodBankController(BloodBankService bloodBankService, InventoryService inventoryService, TransferService transferService) {
        this.bloodBankService = bloodBankService;
        this.inventoryService = inventoryService;
        this.transferService = transferService;
    }

    @PostMapping("/")
    @PreAuthorize("hasAnyRole('HOSPITAL_ADMIN', 'SYSTEM_ADMIN')")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> register(@Valid @RequestBody CreateBloodBankRequest req, @AuthenticationPrincipal AuthenticatedUser caller) {
        BloodBank bank = bloodBankService.register(req, caller.id());
        return Map.of("bloodBank", BloodBankResponse.of(bank, null));
    }

    @GetMapping("/")
    public Map<String, Object> list() {
        List<BloodBankResponse> banks = bloodBankService.list().stream()
            .map(b -> BloodBankResponse.of(b, null))
            .collect(Collectors.toList());
        return Map.of("bloodBanks", banks);
    }

    @GetMapping("/near")
    public Map<String, Object> near(@RequestParam @DecimalMin("-90") @DecimalMax("90") double lat,
                                     @RequestParam @DecimalMin("-180") @DecimalMax("180") double lng,
                                     // Phase 12: bounded (a huge radius returned the whole table)
                                     @RequestParam(defaultValue = "25") @DecimalMin("0.1") @DecimalMax("500") double radiusKm) {
        return Map.of("bloodBanks", bloodBankService.findNearby(lat, lng, radiusKm));
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable UUID id) {
        return Map.of("bloodBank", BloodBankResponse.of(bloodBankService.getOrThrow(id), null));
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasAnyRole('HOSPITAL_ADMIN', 'SYSTEM_ADMIN')")
    public Map<String, Object> update(@PathVariable UUID id, @Valid @RequestBody UpdateBloodBankRequest req,
                                       @AuthenticationPrincipal AuthenticatedUser caller) {
        BloodBank bank = bloodBankService.update(id, req, caller);
        return Map.of("bloodBank", BloodBankResponse.of(bank, null));
    }

    // -------------------------------------------------------------
    // Feature 1 & 2 — inventory
    // -------------------------------------------------------------
    @PostMapping("/{id}/inventory")
    @PreAuthorize("hasAnyRole('HOSPITAL_ADMIN', 'SYSTEM_ADMIN')")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> addInventory(@PathVariable UUID id, @Valid @RequestBody AddInventoryRequest req,
                                             @AuthenticationPrincipal AuthenticatedUser caller) {
        BloodBank bank = bloodBankService.getOrThrow(id);
        bloodBankService.assertManages(bank, caller);
        BloodInventoryBatch batch = inventoryService.addInventory(bank, req);
        return Map.of("inventoryBatch", InventoryBatchResponse.of(batch));
    }

    @GetMapping("/{id}/inventory")
    public Map<String, Object> listInventory(@PathVariable UUID id) {
        List<InventoryBatchResponse> batches = inventoryService.listForBank(id).stream()
            .map(InventoryBatchResponse::of).collect(Collectors.toList());
        return Map.of("inventoryBatches", batches);
    }

    @PutMapping("/inventory/{batchId}")
    @PreAuthorize("hasAnyRole('HOSPITAL_ADMIN', 'SYSTEM_ADMIN')")
    public Map<String, Object> updateInventory(@PathVariable UUID batchId, @Valid @RequestBody UpdateInventoryRequest req,
                                                @AuthenticationPrincipal AuthenticatedUser caller) {
        BloodInventoryBatch existing = inventoryService.getOrThrow(batchId);
        BloodBank bank = bloodBankService.getOrThrow(existing.getBloodBankId());
        bloodBankService.assertManages(bank, caller);
        BloodInventoryBatch updated = inventoryService.updateInventory(batchId, req);
        return Map.of("inventoryBatch", InventoryBatchResponse.of(updated));
    }

    // -------------------------------------------------------------
    // Feature 5 — transfer inventory
    // -------------------------------------------------------------
    @PostMapping("/{id}/transfer")
    @PreAuthorize("hasAnyRole('HOSPITAL_ADMIN', 'SYSTEM_ADMIN')")
    public Map<String, Object> transfer(@PathVariable UUID id, @Valid @RequestBody TransferInventoryRequest req,
                                         @AuthenticationPrincipal AuthenticatedUser caller) {
        BloodBank sourceBank = bloodBankService.getOrThrow(id);
        bloodBankService.assertManages(sourceBank, caller);
        TransferResponse result = transferService.transfer(id, req);
        return Map.of("transfer", result);
    }
}
