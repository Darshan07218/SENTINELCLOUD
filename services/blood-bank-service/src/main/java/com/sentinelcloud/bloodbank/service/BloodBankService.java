package com.sentinelcloud.bloodbank.service;

import com.sentinelcloud.bloodbank.dto.BloodBankDtos.*;
import com.sentinelcloud.bloodbank.entity.BloodBank;
import com.sentinelcloud.bloodbank.exception.ForbiddenException;
import com.sentinelcloud.bloodbank.exception.NotFoundException;
import com.sentinelcloud.bloodbank.repository.BloodBankRepository;
import com.sentinelcloud.bloodbank.security.AuthenticatedUser;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class BloodBankService {

    private final BloodBankRepository bloodBankRepository;

    public BloodBankService(BloodBankRepository bloodBankRepository) {
        this.bloodBankRepository = bloodBankRepository;
    }

    @Transactional
    public BloodBank register(CreateBloodBankRequest req, UUID ownerUserId) {
        BloodBank bank = new BloodBank(req.name(), req.address(), req.latitude(), req.longitude(), req.contactPhone(), ownerUserId);
        return bloodBankRepository.save(bank);
    }

    public BloodBank getOrThrow(UUID id) {
        return bloodBankRepository.findById(id)
            .orElseThrow(() -> new NotFoundException("Blood bank not found."));
    }

    public List<BloodBank> list() {
        return bloodBankRepository.findAll();
    }

    @Transactional
    public BloodBank update(UUID id, UpdateBloodBankRequest req, AuthenticatedUser caller) {
        BloodBank bank = getOrThrow(id);
        assertManages(bank, caller);

        if (req.name() != null) bank.setName(req.name());
        if (req.address() != null) bank.setAddress(req.address());
        if (req.latitude() != null) bank.setLatitude(req.latitude());
        if (req.longitude() != null) bank.setLongitude(req.longitude());
        if (req.contactPhone() != null) bank.setContactPhone(req.contactPhone());
        return bloodBankRepository.save(bank);
    }

    /**
     * Same ownership model as hospital-service: a HOSPITAL_ADMIN may
     * only manage a blood bank whose managed_by_user_id is their own
     * id; SYSTEM_ADMIN may manage any. (HOSPITAL_ADMIN, not a
     * dedicated "blood bank admin" role — the 5-role set from
     * docs/ARCHITECTURE.md doesn't have one, and hospital
     * administrators are the natural owners of blood-bank operations
     * in this project's role model, the same assumption already
     * documented in the original architecture doc's role table.)
     */
    public void assertManages(BloodBank bank, AuthenticatedUser caller) {
        if ("SYSTEM_ADMIN".equals(caller.role())) return;
        if ("HOSPITAL_ADMIN".equals(caller.role()) && caller.id().equals(bank.getManagedByUserId())) return;
        throw new ForbiddenException("You do not manage this blood bank.");
    }

    /**
     * Bounding-box pre-filter + exact Haversine distance/radius cutoff
     * — see GeoUtils and the identical pattern in hospital-service's
     * GET /hospitals/near.
     */
    public List<BloodBankResponse> findNearby(double lat, double lng, double radiusKm) {
        GeoUtils.BoundingBox box = GeoUtils.boundingBoxForRadius(lat, lng, radiusKm);
        List<BloodBank> candidates = bloodBankRepository.findWithinBoundingBox(box.minLat(), box.maxLat(), box.minLng(), box.maxLng());

        return candidates.stream()
            .map(b -> new BankDistance(b, GeoUtils.haversineDistanceKm(lat, lng, b.getLatitude(), b.getLongitude())))
            .filter(bd -> bd.distanceKm() <= radiusKm)
            .sorted(Comparator.comparingDouble(BankDistance::distanceKm))
            .map(bd -> BloodBankResponse.of(bd.bank(), round1(bd.distanceKm())))
            .collect(Collectors.toList());
    }

    private record BankDistance(BloodBank bank, double distanceKm) {}

    private static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }
}
