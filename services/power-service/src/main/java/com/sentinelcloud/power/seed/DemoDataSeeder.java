package com.sentinelcloud.power.seed;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.entity.Substation;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.entity.TransformerReading;
import com.sentinelcloud.power.repository.SubstationRepository;
import com.sentinelcloud.power.repository.TransformerReadingRepository;
import com.sentinelcloud.power.repository.TransformerRepository;
import com.sentinelcloud.power.service.ThresholdEngine;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.io.InputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Random;

/**
 * Idempotent demo data, seeded once on first startup (skipped if data
 * already exists) — same pattern as every other service's seeder in
 * this project. Coordinates are real Pune, India locations, matching
 * the other seeded services so cross-service "near me" demos produce
 * sensible distances.
 *
 * Deliberately builds three different demo scenarios so every feature
 * in this phase has something to show immediately on a fresh
 * `docker compose up`, with no manual telemetry submission required:
 *   - a healthy transformer with a stable, unremarkable history
 *   - an overloaded + hot transformer (rule-based CRITICAL/WARNING)
 *   - a transformer with one statistically anomalous reading buried in
 *     an otherwise-stable history (demonstrates AnomalyDetectionService
 *     catching drift that ThresholdEngine's fixed bands would miss)
 */
@Component
public class DemoDataSeeder implements ApplicationRunner {

    private final SubstationRepository substationRepository;
    private final TransformerRepository transformerRepository;
    private final TransformerReadingRepository readingRepository;
    private final Random random = new Random(42);

    private final JdbcTemplate jdbcTemplate;

    public DemoDataSeeder(SubstationRepository substationRepository, TransformerRepository transformerRepository,
                           TransformerReadingRepository readingRepository,
                           JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
        this.substationRepository = substationRepository;
        this.transformerRepository = transformerRepository;
        this.readingRepository = readingRepository;
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
        if (substationRepository.count() > 0) {
            System.out.println("[power-service] substations already seeded — skipping");
            return;
        }

        // Phase 21: the REAL substations of the OpenStreetMap snapshot
        // (resources/data/pune-substations.json; © OpenStreetMap contributors,
        // ODbL), nearest to the city centre first. Their transformers and
        // telemetry are synthetic (not public). The three demo situations
        // below sit on the three nearest substations.
        List<Substation> substations = loadSubstations();
        Substation first = substations.get(0);
        Substation second = substations.get(1);
        Substation third = substations.get(2);

        // ---- first (nearest): one healthy transformer, one overloaded+hot transformer ----
        Transformer healthy = transformerRepository.save(
            new Transformer(first.getId(), "TXF-01-01", "Main feeder transformer",
                33.0, 400.0, LocalDate.now().minusDays(45)));
        seedStableHistory(healthy, 33.0, 400.0, 55.0, 40.0, 20);

        Transformer overloaded = transformerRepository.save(
            new Transformer(first.getId(), "TXF-01-02", "Auxiliary transformer",
                11.0, 250.0, LocalDate.now().minusDays(200)));
        seedStableHistory(overloaded, 11.0, 250.0, 78.0, 58.0, 15);
        // Latest reading pushes it into overloaded + high-temperature territory —
        // demonstrates features 6/7 (identify overloaded/high-temp) and feature 4 (alerts)
        // immediately without needing to POST a telemetry reading first.
        applyLatestReading(overloaded, 12.3, 305.0, 108.0, 91.0, InfraStatus.CRITICAL);

        // ---- second: a transformer with one statistically anomalous reading buried in a stable history ----
        Transformer drifting = transformerRepository.save(
            new Transformer(second.getId(), "TXF-02-01", "Step-down transformer",
                220.0, 800.0, LocalDate.now().minusDays(90)));
        seedStableHistory(drifting, 220.0, 800.0, 60.0, 45.0, 25);
        // Still comfortably inside ThresholdEngine's fixed rated-value bands (well under the
        // WARNING deviation %), but multiple standard deviations from THIS transformer's own
        // tight historical baseline — this is exactly the case AnomalyDetectionService exists
        // to catch and ThresholdEngine alone would miss. See AnomalyDetectionServiceTest.
        applyLatestReading(drifting, 226.0, 812.0, 64.0, 45.5, InfraStatus.NORMAL);

        // ---- third: a newly commissioned transformer with no telemetry yet ----
        transformerRepository.save(
            new Transformer(third.getId(), "TXF-03-01", "Newly commissioned transformer",
                11.0, 200.0, LocalDate.now().minusDays(10)));

        // ---- every other real substation: one transformer with a calm, stable history ----
        int extra = 0;
        for (int i = 3; i < substations.size(); i++) {
            Substation s = substations.get(i);
            Transformer t = transformerRepository.save(new Transformer(s.getId(), String.format("TXF-%02d-01", i + 1),
                "Distribution transformer", 22.0, 300.0, LocalDate.now().minusDays(30 + (i * 7) % 300)));
            seedStableHistory(t, 22.0, 300.0, 45.0 + (i * 13) % 30, 35.0 + (i * 7) % 15, 12);
            extra++;
        }

        System.out.printf("[power-service] seeded %d real substations (OpenStreetMap), %d transformers, and telemetry history.%n",
            substations.size(), 4 + extra);
    }

    /** The snapshot's substations, saved in order; falls back to three fixed ones if it can't be read. */
    private List<Substation> loadSubstations() {
        List<Substation> saved = new ArrayList<>();
        try (InputStream in = DemoDataSeeder.class.getResourceAsStream("/data/pune-substations.json")) {
            if (in != null) {
                for (JsonNode s : new ObjectMapper().readTree(in).path("items")) {
                    saved.add(substationRepository.save(new Substation(
                        s.path("name").asText(),
                        "Pune (OpenStreetMap " + s.path("osmId").asText() + ")",
                        s.path("latitude").asDouble(), s.path("longitude").asDouble(),
                        gridZone(s), null)));
                }
            }
        } catch (Exception e) {
            System.err.println("[power-service] substation snapshot unreadable, using fallback substations: " + e.getMessage());
        }
        if (saved.size() >= 3) return saved;
        saved.clear();
        saved.add(substationRepository.save(new Substation("Shivajinagar Grid Substation", "Shivajinagar, Pune", 18.5308, 73.8475, "Pune Central Grid", null)));
        saved.add(substationRepository.save(new Substation("Hadapsar 220kV Substation", "Hadapsar, Pune", 18.5089, 73.9260, "Pune East Grid", null)));
        saved.add(substationRepository.save(new Substation("Baner Distribution Substation", "Baner, Pune", 18.5590, 73.7868, "Pune West Grid", null)));
        return saved;
    }

    /** "Pune Central/North/South/East/West Grid" from the substation's position, plus its highest voltage. */
    static String gridZone(JsonNode s) {
        double dLat = s.path("latitude").asDouble() - 18.5204;
        double dLng = s.path("longitude").asDouble() - 73.8567;
        String zone = Math.hypot(dLat, dLng) < 0.04 ? "Central" : Math.abs(dLat) > Math.abs(dLng) ? (dLat > 0 ? "North" : "South") : (dLng > 0 ? "East" : "West");
        String kv = s.path("maxVoltageKv").isNumber() ? " · " + Math.round(s.path("maxVoltageKv").asDouble()) + " kV" : "";
        return "Pune " + zone + " Grid" + kv;
    }

    /**
     * Builds a run of small-jitter historical readings around the
     * given baseline for a transformer, oldest first, then updates the
     * transformer's denormalized snapshot to the last one written —
     * gives AnomalyDetectionService a real baseline to compare against
     * immediately.
     */
    private void seedStableHistory(Transformer transformer, double baseVoltage, double baseCurrent,
                                    double baseLoad, double baseTemp, int count) {
        Instant now = Instant.now();
        TransformerReading last = null;
        for (int i = count; i >= 1; i--) {
            double voltage = jitter(baseVoltage, baseVoltage * 0.01);
            double current = jitter(baseCurrent, baseCurrent * 0.02);
            double load = jitter(baseLoad, 3.0);
            double temp = jitter(baseTemp, 2.0);
            Instant recordedAt = now.minus(i * 6L, ChronoUnit.HOURS);

            ThresholdEngine.EvaluationResult evaluation = ThresholdEngine.evaluate(
                voltage, current, load, temp, transformer.getRatedVoltageKv(), transformer.getRatedCurrentAmps());

            TransformerReading reading = new TransformerReading(transformer.getId(), voltage, current, load, temp,
                false, null, recordedAt);
            last = readingRepository.save(reading);
            transformer.applyTelemetrySnapshot(voltage, current, load, temp, recordedAt, evaluation.overallStatus());
        }
        transformerRepository.save(transformer);
    }

    /** Appends one final reading (the "current" state demo scenarios pivot on) and updates the snapshot/status. */
    private void applyLatestReading(Transformer transformer, double voltage, double current, double load, double temp, InfraStatus status) {
        Instant recordedAt = Instant.now();
        String reasons = status == InfraStatus.NORMAL ? null : (status + " threshold breach in seeded demo scenario");
        TransformerReading reading = new TransformerReading(transformer.getId(), voltage, current, load, temp,
            status != InfraStatus.NORMAL, reasons, recordedAt);
        readingRepository.save(reading);
        transformer.applyTelemetrySnapshot(voltage, current, load, temp, recordedAt, status);
        transformerRepository.save(transformer);
    }

    private double jitter(double base, double spread) {
        return Math.round((base + (random.nextDouble() - 0.5) * 2 * spread) * 100.0) / 100.0;
    }
}
