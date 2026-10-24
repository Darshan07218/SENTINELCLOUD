package com.sentinelcloud.power.service;

import com.sentinelcloud.power.dto.SubstationDtos.*;
import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.exception.ForbiddenException;
import com.sentinelcloud.power.exception.NotFoundException;
import com.sentinelcloud.power.repository.SubstationRepository;
import com.sentinelcloud.power.security.AuthenticatedUser;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/** Feature 1 (add infrastructure — substation half) plus standard CRUD/ownership/geo-search. */
@Service
public class SubstationService {

    private final SubstationRepository substationRepository;

    public SubstationService(SubstationRepository substationRepository) {
        this.substationRepository = substationRepository;
    }

    @Transactional
    public Substation register(CreateSubstationRequest req, UUID ownerUserId) {
        Substation substation = new Substation(req.name(), req.address(), req.latitude(), req.longitude(), req.gridZone(), ownerUserId);
        return substationRepository.save(substation);
    }

    public Substation getOrThrow(UUID id) {
        return substationRepository.findById(id).orElseThrow(() -> new NotFoundException("Substation not found."));
    }

    public List<Substation> list() {
        return substationRepository.findAll();
    }

    @Transactional
    public Substation update(UUID id, UpdateSubstationRequest req, AuthenticatedUser caller) {
        Substation substation = getOrThrow(id);
        assertManages(substation, caller);

        if (req.name() != null) substation.setName(req.name());
        if (req.address() != null) substation.setAddress(req.address());
        if (req.latitude() != null) substation.setLatitude(req.latitude());
        if (req.longitude() != null) substation.setLongitude(req.longitude());
        if (req.gridZone() != null) substation.setGridZone(req.gridZone());
        return substationRepository.save(substation);
    }

    /**
     * Same ownership model as every other domain service: an
     * INFRASTRUCTURE_ADMIN may only manage a substation they registered
     * (managed_by_user_id == their own id); SYSTEM_ADMIN may manage any.
     */
    public void assertManages(Substation substation, AuthenticatedUser caller) {
        if ("SYSTEM_ADMIN".equals(caller.role())) return;
        if ("INFRASTRUCTURE_ADMIN".equals(caller.role()) && caller.id().equals(substation.getManagedByUserId())) return;
        throw new ForbiddenException("You do not manage this substation.");
    }

    /** Bounding-box pre-filter + exact Haversine distance/radius cutoff. */
    public List<SubstationResponse> findNearby(double lat, double lng, double radiusKm) {
        GeoUtils.BoundingBox box = GeoUtils.boundingBoxForRadius(lat, lng, radiusKm);
        List<Substation> candidates = substationRepository.findWithinBoundingBox(box.minLat(), box.maxLat(), box.minLng(), box.maxLng());

        return candidates.stream()
            .map(s -> new SubstationDistance(s, GeoUtils.haversineDistanceKm(lat, lng, s.getLatitude(), s.getLongitude())))
            .filter(sd -> sd.distanceKm() <= radiusKm)
            .sorted(Comparator.comparingDouble(SubstationDistance::distanceKm))
            .map(sd -> SubstationResponse.of(sd.substation(), round1(sd.distanceKm())))
            .collect(Collectors.toList());
    }

    private record SubstationDistance(Substation substation, double distanceKm) {}

    private static double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }
}
