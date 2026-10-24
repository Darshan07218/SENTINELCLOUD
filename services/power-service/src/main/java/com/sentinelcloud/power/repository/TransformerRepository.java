package com.sentinelcloud.power.repository;

import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.entity.Transformer;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

public interface TransformerRepository extends JpaRepository<Transformer, UUID> {

    List<Transformer> findBySubstationId(UUID substationId);

    List<Transformer> findByStatus(InfraStatus status);

    List<Transformer> findByStatusIn(List<InfraStatus> statuses);

    boolean existsBySubstationIdAndCode(UUID substationId, String code);

    /** Feature 6 — overloaded: last recorded load percentage at or above the given floor. */
    @Query("SELECT t FROM Transformer t WHERE t.lastLoadPercentage IS NOT NULL AND t.lastLoadPercentage >= :floor ORDER BY t.lastLoadPercentage DESC")
    List<Transformer> findOverloaded(@Param("floor") double floor);

    /** Feature 7 — high temperature: last recorded temperature at or above the given floor. */
    @Query("SELECT t FROM Transformer t WHERE t.lastTemperatureCelsius IS NOT NULL AND t.lastTemperatureCelsius >= :floor ORDER BY t.lastTemperatureCelsius DESC")
    List<Transformer> findHighTemperature(@Param("floor") double floor);

    @Query("SELECT t FROM Transformer t WHERE t.lastInspectionDate IS NULL OR t.lastInspectionDate <= :cutoff")
    List<Transformer> findInspectionOverdue(@Param("cutoff") LocalDate cutoff);
}
