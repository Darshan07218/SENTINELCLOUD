package com.sentinelcloud.bloodbank.repository;

import com.sentinelcloud.bloodbank.domain.BloodGroup;
import com.sentinelcloud.bloodbank.domain.RhFactor;
import com.sentinelcloud.bloodbank.entity.BloodDemandRecord;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface BloodDemandRecordRepository extends JpaRepository<BloodDemandRecord, UUID> {
    List<BloodDemandRecord> findByBloodGroupAndRhFactorOrderByPeriodStartAsc(BloodGroup bloodGroup, RhFactor rhFactor);
}
