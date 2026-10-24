package com.sentinelcloud.power.repository;

import com.sentinelcloud.power.entity.TransformerFailureEvent;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface TransformerFailureEventRepository extends JpaRepository<TransformerFailureEvent, UUID> {

    List<TransformerFailureEvent> findByTransformerIdOrderByOccurredAtDesc(UUID transformerId);

    /** Normally zero or one row; a list so legacy duplicates can't break the lookup. */
    List<TransformerFailureEvent> findByTransformerIdAndResolvedAtIsNull(UUID transformerId);

    List<TransformerFailureEvent> findByResolvedAtIsNull();
}
