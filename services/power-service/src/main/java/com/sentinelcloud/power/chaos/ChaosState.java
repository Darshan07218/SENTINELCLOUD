package com.sentinelcloud.power.chaos;

import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.time.Instant;

/**
 * Phase 11 — the in-memory fault this pod is simulating, if any. Lives
 * only in memory ON PURPOSE: when Kubernetes restarts the container,
 * the fault disappears, and that restart IS the recovery the
 * Resilience Demo shows.
 */
@Component
public class ChaosState {

    private volatile String mode;       // null = healthy
    private volatile Instant since;

    public boolean isFaulty() {
        return mode != null;
    }

    public String mode() {
        return mode;
    }

    public Instant since() {
        return since;
    }

    public void set(String newMode) {
        this.mode = newMode;
        this.since = newMode == null ? null : Instant.now();
    }

    /** The pod name in Kubernetes (HOSTNAME), the container id under Compose. */
    public static String podName() {
        String host = System.getenv("HOSTNAME");
        if (host != null && !host.isBlank()) return host;
        try {
            return InetAddress.getLocalHost().getHostName();
        } catch (Exception e) {
            return "unknown";
        }
    }
}
