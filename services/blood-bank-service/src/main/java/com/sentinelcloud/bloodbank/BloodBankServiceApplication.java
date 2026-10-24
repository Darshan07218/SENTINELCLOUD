package com.sentinelcloud.bloodbank;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * SentinelCloud Blood Bank Intelligence Service.
 *
 * Phase 5: full business logic — blood bank registration, batch-level
 * inventory (add/update/transfer), FEFO reservations, low-stock and
 * near-expiry detection, aggregated shortage alerts, and a PROTOTYPE
 * demand forecasting endpoint (see service/ForecastingService.java —
 * NOT medically validated, demo/synthetic data only). Schema managed
 * by Flyway (src/main/resources/db/migration/); JWT verified
 * independently via security/JwtService.java, same shared-secret
 * pattern as every other service in this project.
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
public class BloodBankServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(BloodBankServiceApplication.class, args);
    }
}
