package com.sentinelcloud.bloodbank.seed;

import com.sentinelcloud.bloodbank.domain.BloodGroup;
import com.sentinelcloud.bloodbank.domain.RhFactor;
import com.sentinelcloud.bloodbank.entity.BloodBank;
import com.sentinelcloud.bloodbank.entity.BloodDemandRecord;
import com.sentinelcloud.bloodbank.entity.BloodInventoryBatch;
import com.sentinelcloud.bloodbank.repository.BloodBankRepository;
import com.sentinelcloud.bloodbank.repository.BloodDemandRecordRepository;
import com.sentinelcloud.bloodbank.repository.BloodInventoryBatchRepository;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;
import java.util.Random;

/**
 * Idempotent demo data, seeded once on first startup (skipped if data
 * already exists) — same pattern as hospital-service's and
 * ambulance-service's seed scripts. Coordinates are real Pune, India
 * locations matching this project's other seeded services, so
 * cross-service "near me" demos produce sensible distances.
 */
@Component
public class DemoDataSeeder implements ApplicationRunner {

    private final BloodBankRepository bloodBankRepository;
    private final BloodInventoryBatchRepository batchRepository;
    private final BloodDemandRecordRepository demandRecordRepository;

    private final JdbcTemplate jdbcTemplate;

    public DemoDataSeeder(BloodBankRepository bloodBankRepository, BloodInventoryBatchRepository batchRepository,
                           BloodDemandRecordRepository demandRecordRepository,
                           JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
        this.bloodBankRepository = bloodBankRepository;
        this.batchRepository = batchRepository;
        this.demandRecordRepository = demandRecordRepository;
    }

    /**
     * Phase 9 (Kubernetes): the whole seed runs in ONE transaction that
     * first takes a transaction-scoped Postgres advisory lock. When
     * several replicas start at once (kubectl scale, HPA, rolling
     * update) they would otherwise all run the "count() == 0 → insert"
     * check simultaneously and seed the demo data N times. The first
     * pod takes the lock and seeds; the others block on it, then see
     * count() > 0 and skip. pg_advisory_xact_lock is released
     * automatically at commit/rollback (or if the pod dies), so there
     * is no stale lock to clean up. Flyway already does the equivalent
     * for schema migrations, so only seeding needed this.
     */
    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        jdbcTemplate.execute("SELECT pg_advisory_xact_lock(9000002)");
        seedBloodBanksAndInventory();
        seedDemandHistory();
    }

    private void seedBloodBanksAndInventory() {
        if (bloodBankRepository.count() > 0) {
            System.out.println("[blood-bank-service] blood banks already seeded — skipping");
            return;
        }

        BloodBank pune1 = bloodBankRepository.save(new BloodBank(
            "Pune Regional Blood Bank", "Sassoon Rd, Pune, Maharashtra 411001", 18.5236, 73.8737,
            "+91-20-2612-8100", null));
        BloodBank pune2 = bloodBankRepository.save(new BloodBank(
            "Ruby Hall Blood Centre", "40, Sassoon Rd, Pune, Maharashtra 411001", 18.5308, 73.8794,
            "+91-20-6645-5200", null));
        BloodBank pune3 = bloodBankRepository.save(new BloodBank(
            "Deenanath Mangeshkar Blood Bank", "Erandwane, Pune, Maharashtra 411004", 18.5018, 73.8288,
            "+91-20-4015-1100", null));

        LocalDate today = LocalDate.now();

        // A realistic, deliberately uneven spread: some types well
        // stocked, some low, some already expiring soon, one at zero
        // — so the low-stock/expiry/alert dashboards have real content
        // immediately after `docker compose up`, without requiring any
        // manual setup first.
        seedBatch(pune1, BloodGroup.O, RhFactor.POSITIVE, 18, today.minusDays(10), today.plusDays(35));
        seedBatch(pune1, BloodGroup.O, RhFactor.NEGATIVE, 3, today.minusDays(5), today.plusDays(5));   // low stock AND expiring soon
        seedBatch(pune1, BloodGroup.A, RhFactor.POSITIVE, 14, today.minusDays(20), today.plusDays(22));
        seedBatch(pune1, BloodGroup.AB, RhFactor.NEGATIVE, 1, today.minusDays(30), today.plusDays(12)); // critical low stock

        seedBatch(pune2, BloodGroup.B, RhFactor.POSITIVE, 22, today.minusDays(8), today.plusDays(34));
        seedBatch(pune2, BloodGroup.O, RhFactor.POSITIVE, 9, today.minusDays(38), today.plusDays(4));   // expiring soon
        seedBatch(pune2, BloodGroup.A, RhFactor.NEGATIVE, 6, today.minusDays(15), today.plusDays(27));
        seedBatch(pune2, BloodGroup.AB, RhFactor.POSITIVE, 1, today.minusDays(40), today.plusDays(2));  // near-zero, expiring soon

        seedBatch(pune3, BloodGroup.B, RhFactor.NEGATIVE, 4, today.minusDays(12), today.plusDays(30));  // low stock
        seedBatch(pune3, BloodGroup.O, RhFactor.POSITIVE, 16, today.minusDays(6), today.plusDays(36));
        seedBatch(pune3, BloodGroup.A, RhFactor.POSITIVE, 11, today.minusDays(18), today.plusDays(24));

        System.out.println("[blood-bank-service] seeded 3 blood banks with sample inventory batches");
    }

    private void seedBatch(BloodBank bank, BloodGroup group, RhFactor rh, int units, LocalDate collected, LocalDate expires) {
        batchRepository.save(new BloodInventoryBatch(bank.getId(), group, rh, units, collected, expires));
    }

    /**
     * Synthetic historical demand for the PROTOTYPE forecasting module
     * (service/ForecastingService.java) — 6 monthly periods per blood
     * type, with a mild upward trend plus randomness, so the linear
     * regression forecast has something realistic-looking to extrapolate
     * from. This is demo data, not real hospital request history —
     * repeated explicitly here and in every forecast API response.
     */
    private void seedDemandHistory() {
        if (!demandRecordRepository.findAll().isEmpty()) {
            System.out.println("[blood-bank-service] demand history already seeded — skipping");
            return;
        }

        Random random = new Random(42); // fixed seed: reproducible demo data across restarts
        LocalDate periodStart = LocalDate.now().minusMonths(6).withDayOfMonth(1);

        // {baseUnits, monthlyGrowth} per blood type, roughly reflecting
        // real-world population blood-type prevalence (O+ and A+ most
        // common, AB- rarest) — purely for a realistic-looking demo,
        // not derived from any actual dataset.
        List<int[]> baselinesByType = List.of(
            new int[]{40, 2},  // O+
            new int[]{10, 0},  // O-
            new int[]{35, 1},  // A+
            new int[]{8, 0},   // A-
            new int[]{18, 1},  // B+
            new int[]{5, 0},   // B-
            new int[]{6, 0},   // AB+
            new int[]{2, 0}    // AB-
        );
        List<BloodGroup> groups = List.of(BloodGroup.O, BloodGroup.O, BloodGroup.A, BloodGroup.A,
            BloodGroup.B, BloodGroup.B, BloodGroup.AB, BloodGroup.AB);
        List<RhFactor> rhs = List.of(RhFactor.POSITIVE, RhFactor.NEGATIVE, RhFactor.POSITIVE, RhFactor.NEGATIVE,
            RhFactor.POSITIVE, RhFactor.NEGATIVE, RhFactor.POSITIVE, RhFactor.NEGATIVE);

        for (int typeIndex = 0; typeIndex < groups.size(); typeIndex++) {
            int base = baselinesByType.get(typeIndex)[0];
            int growth = baselinesByType.get(typeIndex)[1];
            for (int month = 0; month < 6; month++) {
                LocalDate start = periodStart.plusMonths(month);
                LocalDate end = start.plusMonths(1).minusDays(1);
                int noise = random.nextInt(5) - 2; // +/- small random variation
                int units = Math.max(0, base + growth * month + noise);
                demandRecordRepository.save(new BloodDemandRecord(groups.get(typeIndex), rhs.get(typeIndex), start, end, units));
            }
        }

        System.out.println("[blood-bank-service] seeded 48 synthetic demand records (6 months x 8 blood types) for the forecasting prototype");
    }
}
