package com.sentinelcloud.bloodbank.config;

import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.binder.MeterBinder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;

/**
 * Phase 10: the few metrics Micrometer doesn't already provide in the
 * SAME form the Node services expose, so dashboards need no
 * per-language queries:
 *
 *   process_cpu_seconds_total       — total CPU time (Micrometer only has a 0–1 "usage" gauge)
 *   process_resident_memory_bytes   — RSS from /proc (what the kernel/OOM-killer actually counts,
 *                                     unlike JVM heap gauges)
 *   sentinel_dependency_up{dependency="postgres"}
 *
 * Everything else — http_server_requests_seconds, jvm_*, hikaricp_* —
 * comes from Spring Boot Actuator + Micrometer at /prometheus.
 */
@Configuration
public class ObservabilityMetrics {

    @Bean
    public MeterBinder sentinelProcessAndDependencyMetrics(DataSource dataSource) {
        return registry -> {
            if (ManagementFactory.getOperatingSystemMXBean() instanceof com.sun.management.OperatingSystemMXBean os) {
                FunctionCounter.builder("process.cpu.seconds", os, bean -> bean.getProcessCpuTime() / 1e9)
                    .description("Total user and system CPU time spent in seconds")
                    .baseUnit("seconds")
                    .register(registry);
            }
            Gauge.builder("process.resident.memory", ObservabilityMetrics::residentMemoryBytes)
                .description("Resident memory size in bytes")
                .baseUnit("bytes")
                .register(registry);
            Gauge.builder("sentinel.dependency.up", dataSource, ObservabilityMetrics::databaseUp)
                .description("1 if this service can currently reach the dependency, else 0")
                .tag("dependency", "postgres")
                .register(registry);
        };
    }

    /** Borrows a pooled connection and validates it; 0 on any failure or a >1s check. */
    static double databaseUp(DataSource dataSource) {
        try (Connection connection = dataSource.getConnection()) {
            return connection.isValid(1) ? 1 : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    /** Second field of /proc/self/statm = resident pages. NaN off Linux (e.g. local IDE runs on Windows/macOS). */
    static double residentMemoryBytes() {
        try {
            String[] fields = Files.readString(Path.of("/proc/self/statm")).trim().split("\\s+");
            return Long.parseLong(fields[1]) * 4096d;
        } catch (Exception e) {
            return Double.NaN;
        }
    }
}
