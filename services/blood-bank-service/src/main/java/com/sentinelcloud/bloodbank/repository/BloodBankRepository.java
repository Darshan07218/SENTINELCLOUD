package com.sentinelcloud.bloodbank.repository;

import com.sentinelcloud.bloodbank.entity.BloodBank;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface BloodBankRepository extends JpaRepository<BloodBank, UUID> {

    /**
     * Coarse bounding-box pre-filter for "near a location" search —
     * the same pattern used by hospital-service's findWithinBoundingBox
     * and ambulance-service's findAvailableWithinBoundingBox: an
     * indexed range query narrows candidates cheaply, then the exact
     * Haversine distance and radius cutoff happen in application code
     * (see service/BloodBankService.java findNearby).
     */
    @Query("SELECT b FROM BloodBank b WHERE b.latitude BETWEEN :minLat AND :maxLat AND b.longitude BETWEEN :minLng AND :maxLng")
    List<BloodBank> findWithinBoundingBox(@Param("minLat") double minLat, @Param("maxLat") double maxLat,
                                           @Param("minLng") double minLng, @Param("maxLng") double maxLng);
}
