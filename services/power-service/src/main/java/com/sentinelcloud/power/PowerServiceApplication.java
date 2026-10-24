package com.sentinelcloud.power;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * SentinelCloud Power Infrastructure Service.
 *
 * Phase 6: full business logic — substation/transformer registration,
 * telemetry ingestion, rule-based threshold evaluation
 * (service/ThresholdEngine.java) combined with per-transformer
 * statistical anomaly detection against each transformer's own
 * history (service/AnomalyDetectionService.java), automatic
 * NORMAL/WARNING/CRITICAL/FAILED status transitions with a failure
 * history ledger, aggregated infrastructure alerts, overloaded /
 * high-temperature detection, and map data. Schema managed by Flyway
 * (src/main/resources/db/migration/); JWT verified independently via
 * security/JwtService.java, same shared-secret pattern as every other
 * service in this project.
 *
 * Health/readiness via Spring Boot Actuator, exposed at the service
 * root (see application.yml):
 *   - GET /health
 *   - GET /health/liveness
 *   - GET /health/readiness
 *   - GET /prometheus
 *
 * API docs (springdoc, auto-generated from controller annotations):
 *   - GET /swagger-ui.html
 *   - GET /v3/api-docs
 */
@SpringBootApplication
public class PowerServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(PowerServiceApplication.class, args);
    }
}
