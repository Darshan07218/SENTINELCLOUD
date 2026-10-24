package com.sentinelcloud.power.repository;

import com.sentinelcloud.power.entity.TransformerReading;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface TransformerReadingRepository extends JpaRepository<TransformerReading, UUID> {

    /**
     * Feature 5 (view historical readings) AND the baseline window for
     * AnomalyDetectionService — most recent readings for a
     * transformer, capped by the Pageable so both a paged API response
     * and a long-lived transformer's statistical baseline stay a
     * recent rolling window rather than "since the dawn of time."
     */
    List<TransformerReading> findByTransformerIdOrderByRecordedAtDesc(UUID transformerId, Pageable pageable);

    long countByTransformerId(UUID transformerId);

    /** Phase 18: the risk forecast's window — newest first, capped by the Pageable. */
    List<TransformerReading> findByTransformerIdAndRecordedAtAfterOrderByRecordedAtDesc(UUID transformerId, Instant after, Pageable pageable);
}
