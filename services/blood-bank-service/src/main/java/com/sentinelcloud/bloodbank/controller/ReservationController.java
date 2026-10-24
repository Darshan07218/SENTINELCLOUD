package com.sentinelcloud.bloodbank.controller;

import com.sentinelcloud.bloodbank.dto.ReservationDtos.*;
import com.sentinelcloud.bloodbank.entity.BloodBank;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.entity.BloodReservation;
import com.sentinelcloud.bloodbank.exception.ForbiddenException;
import com.sentinelcloud.bloodbank.security.AuthenticatedUser;
import com.sentinelcloud.bloodbank.service.BloodBankService;
import com.sentinelcloud.bloodbank.service.InventoryService;
import com.sentinelcloud.bloodbank.service.ReservationService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Feature 3 (reserve blood) and feature 4 (release reservation).
 *
 * Roles are restricted to HOSPITAL_ADMIN and SYSTEM_ADMIN, matching
 * exactly the gateway's existing write-role rule for the /blood-banks
 * prefix (configured in Phase 2, unchanged here) — an EMERGENCY_OPERATOR
 * write request would be blocked by the gateway before it ever reaches
 * this service, so allowing it here too would be dead code. Letting
 * EMERGENCY_OPERATOR reserve blood directly during an active emergency
 * is a reasonable future enhancement, but it requires a gateway
 * routeAccessRules.js change (out of scope for "don't modify unrelated
 * services" this phase) — noted in docs/PHASE-5-BLOOD-BANK.md.
 */
@RestController
public class ReservationController {

    private final ReservationService reservationService;
    private final InventoryService inventoryService;
    private final BloodBankService bloodBankService;

    public ReservationController(ReservationService reservationService, InventoryService inventoryService,
                                 BloodBankService bloodBankService) {
        this.reservationService = reservationService;
        this.inventoryService = inventoryService;
        this.bloodBankService = bloodBankService;
    }

    @PostMapping("/{bloodBankId}/reservations")
    @PreAuthorize("hasAnyRole('HOSPITAL_ADMIN', 'SYSTEM_ADMIN')")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> reserve(@PathVariable UUID bloodBankId, @Valid @RequestBody CreateReservationRequest req,
                                        @AuthenticationPrincipal AuthenticatedUser caller) {
        BloodReservation reservation = reservationService.reserveBlood(bloodBankId, req, caller.id());
        return Map.of("reservation", ReservationResponse.of(reservation));
    }

    @PostMapping("/reservations/{id}/release")
    @PreAuthorize("hasAnyRole('HOSPITAL_ADMIN', 'SYSTEM_ADMIN')")
    public Map<String, Object> release(@PathVariable UUID id, @AuthenticationPrincipal AuthenticatedUser caller) {
        BloodReservation existing = reservationService.getOrThrow(id);
        BloodInventoryBatch batch = inventoryService.getOrThrow(existing.getBatchId());
        BloodBank bank = bloodBankService.getOrThrow(batch.getBloodBankId());
        if (!ReservationService.canRelease(existing, bank, caller)) {
            throw new ForbiddenException("Only the admin who made this reservation, an admin of the holding blood bank, or a SYSTEM_ADMIN can release it.");
        }
        BloodReservation reservation = reservationService.releaseReservation(id);
        return Map.of("reservation", ReservationResponse.of(reservation));
    }

    @GetMapping("/reservations/active")
    public Map<String, Object> listActive() {
        List<ReservationResponse> reservations = reservationService.listActive().stream()
            .map(ReservationResponse::of).collect(Collectors.toList());
        return Map.of("reservations", reservations);
    }
}
