package com.sentinelcloud.power.repository;

import com.sentinelcloud.power.entity.Substation;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.UUID;

public interface SubstationRepository extends JpaRepository<Substation, UUID> {

    /** Coarse bounding-box pre-filter for "near a location" search — same pattern as every other geo-search service here. */
    @Query("SELECT s FROM Substation s WHERE s.latitude BETWEEN :minLat AND :maxLat AND s.longitude BETWEEN :minLng AND :maxLng")
    List<Substation> findWithinBoundingBox(@Param("minLat") double minLat, @Param("maxLat") double maxLat,
                                            @Param("minLng") double minLng, @Param("maxLng") double maxLng);
}
