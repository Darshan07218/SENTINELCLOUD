package com.sentinelcloud.power.controller;

import jakarta.validation.constraints.*;
import com.sentinelcloud.power.dto.SubstationDtos.*;
import com.sentinelcloud.power.dto.TransformerDtos.*;
import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.security.AuthenticatedUser;
import com.sentinelcloud.power.service.SubstationService;
import com.sentinelcloud.power.service.TransformerService;
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
 * Substation CRUD + transformer registration/listing under a
 * substation — mirrors blood-bank-service's BloodBankController (root
 * resource + a nested sub-resource), which the gateway strips the
 * "/power" prefix down to before proxying here.
 */
@RestController
public class SubstationController {

    private final SubstationService substationService;
    private final TransformerService transformerService;

    public SubstationController(SubstationService substationService, TransformerService transformerService) {
        this.substationService = substationService;
        this.transformerService = transformerService;
    }

    @PostMapping("/")
    @PreAuthorize("hasAnyRole('INFRASTRUCTURE_ADMIN', 'SYSTEM_ADMIN')")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> register(@Valid @RequestBody CreateSubstationRequest req, @AuthenticationPrincipal AuthenticatedUser caller) {
        Substation substation = substationService.register(req, caller.id());
        return Map.of("substation", SubstationResponse.of(substation, null));
    }

    @GetMapping("/")
    public Map<String, Object> list() {
        List<SubstationResponse> substations = substationService.list().stream()
            .map(s -> SubstationResponse.of(s, null))
            .collect(Collectors.toList());
        return Map.of("substations", substations);
    }

    @GetMapping("/near")
    public Map<String, Object> near(@RequestParam @DecimalMin("-90") @DecimalMax("90") double lat,
                                     @RequestParam @DecimalMin("-180") @DecimalMax("180") double lng,
                                     // Phase 12: bounded (a huge radius returned the whole table)
                                     @RequestParam(defaultValue = "25") @DecimalMin("0.1") @DecimalMax("500") double radiusKm) {
        return Map.of("substations", substationService.findNearby(lat, lng, radiusKm));
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable UUID id) {
        return Map.of("substation", SubstationResponse.of(substationService.getOrThrow(id), null));
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasAnyRole('INFRASTRUCTURE_ADMIN', 'SYSTEM_ADMIN')")
    public Map<String, Object> update(@PathVariable UUID id, @Valid @RequestBody UpdateSubstationRequest req,
                                       @AuthenticationPrincipal AuthenticatedUser caller) {
        Substation substation = substationService.update(id, req, caller);
        return Map.of("substation", SubstationResponse.of(substation, null));
    }

    // -------------------------------------------------------------
    // Feature 1 — add infrastructure (transformers, under a substation)
    // -------------------------------------------------------------
    @PostMapping("/{id}/transformers")
    @PreAuthorize("hasAnyRole('INFRASTRUCTURE_ADMIN', 'SYSTEM_ADMIN')")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> addTransformer(@PathVariable UUID id, @Valid @RequestBody CreateTransformerRequest req,
                                               @AuthenticationPrincipal AuthenticatedUser caller) {
        Substation substation = substationService.getOrThrow(id);
        substationService.assertManages(substation, caller);
        Transformer transformer = transformerService.addTransformer(substation, req);
        return Map.of("transformer", TransformerResponse.of(transformer));
    }

    @GetMapping("/{id}/transformers")
    public Map<String, Object> listTransformers(@PathVariable UUID id) {
        List<TransformerResponse> transformers = transformerService.listForSubstation(id).stream()
            .map(TransformerResponse::of).collect(Collectors.toList());
        return Map.of("transformers", transformers);
    }
}
