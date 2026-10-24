package com.sentinelcloud.bloodbank.chaos;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.availability.AvailabilityChangeEvent;
import org.springframework.boot.availability.LivenessState;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Phase 11 — controlled fault injection for the Resilience Demo; same
 * contract as the Node services' src/chaos.js. SOFTWARE-only: it makes
 * this one pod misbehave so the demo can show Kubernetes detecting and
 * recovering. Off unless CHAOS_ENABLED=true and CHAOS_TOKEN is set; the
 * caller must send X-Chaos-Token. /internal/** is never proxied by the
 * gateway.
 *
 *   POST /internal/chaos?mode=unhealthy  publish LivenessState.BROKEN +
 *        ReadinessState.REFUSING_TRAFFIC through Spring Boot's real
 *        availability API → /health/readiness and /health/liveness
 *        return 503 → Kubernetes removes the pod from the Service, then
 *        restarts the container.
 *   POST /internal/chaos?mode=crash      hard JVM halt (exit code 1, no
 *        graceful shutdown) — what an unrecoverable crash looks like.
 *   POST /internal/chaos?mode=clear      back to CORRECT / ACCEPTING_TRAFFIC
 *   GET  /internal/whoami                which replica answered
 *   GET  /internal/work?ms=40            CPU-bound work (≤ 500ms)
 */
@RestController
@RequestMapping("/internal")
public class ChaosController {

    private static final int MAX_WORK_MS = 500;

    private final ApplicationContext context;
    private final ChaosState state;
    private final boolean enabled;
    private final String token;

    public ChaosController(ApplicationContext context, ChaosState state,
                           @Value("${sentinel.chaos.enabled:false}") boolean enabled,
                           @Value("${sentinel.chaos.token:}") String token) {
        this.context = context;
        this.state = state;
        this.enabled = enabled && token != null && !token.isBlank();
        this.token = token;
        if (this.enabled) {
            System.out.println("[blood-bank-service] fault injection ENABLED (Phase 11 Resilience Demo) — /internal/** requires X-Chaos-Token");
        }
    }

    @PostMapping("/chaos")
    public ResponseEntity<Map<String, Object>> chaos(@RequestParam String mode,
                                                     @RequestHeader(value = "X-Chaos-Token", required = false) String given) {
        if (!authorized(given)) return notFound();
        switch (mode) {
            case "unhealthy" -> {
                state.set("unhealthy");
                AvailabilityChangeEvent.publish(context, LivenessState.BROKEN);
                AvailabilityChangeEvent.publish(context, ReadinessState.REFUSING_TRAFFIC);
                System.err.println("[blood-bank-service] SIMULATED FAILURE: LivenessState=BROKEN, ReadinessState=REFUSING_TRAFFIC");
                return ResponseEntity.ok(body());
            }
            case "crash" -> {
                System.err.println("[blood-bank-service] SIMULATED CRASH requested — halting the JVM with exit code 1");
                Thread crasher = new Thread(() -> {
                    try {
                        Thread.sleep(100); // let the 202 flush first
                    } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                    }
                    Runtime.getRuntime().halt(1);
                });
                crasher.setDaemon(true);
                crasher.start();
                Map<String, Object> b = body();
                b.put("fault", Map.of("mode", "crash"));
                return ResponseEntity.status(HttpStatus.ACCEPTED).body(b);
            }
            case "clear" -> {
                state.set(null);
                AvailabilityChangeEvent.publish(context, LivenessState.CORRECT);
                AvailabilityChangeEvent.publish(context, ReadinessState.ACCEPTING_TRAFFIC);
                return ResponseEntity.ok(body());
            }
            default -> {
                return ResponseEntity.badRequest().body(Map.of("error", Map.of(
                    "code", "INVALID_MODE", "message", "mode must be one of unhealthy, crash, clear")));
            }
        }
    }

    @GetMapping("/whoami")
    public ResponseEntity<Map<String, Object>> whoami(@RequestHeader(value = "X-Chaos-Token", required = false) String given) {
        if (!authorized(given)) return notFound();
        return ResponseEntity.ok(body());   // ChaosFilter already turned this into a 503 if faulty
    }

    @GetMapping("/work")
    public ResponseEntity<Map<String, Object>> work(@RequestParam(defaultValue = "20") int ms,
                                                    @RequestHeader(value = "X-Chaos-Token", required = false) String given) {
        if (!authorized(given)) return notFound();
        int bounded = Math.max(1, Math.min(MAX_WORK_MS, ms));
        long end = System.currentTimeMillis() + bounded;
        double x = 0;
        while (System.currentTimeMillis() < end) x += Math.sqrt(x + 1);   // deliberately CPU-bound
        Map<String, Object> b = body();
        b.put("ms", bounded);
        return ResponseEntity.ok(b);
    }

    private boolean authorized(String given) {
        if (!enabled || given == null) return false;
        return MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
    }

    private Map<String, Object> body() {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("pod", ChaosState.podName());
        b.put("service", "blood-bank-service");
        b.put("fault", state.isFaulty() ? Map.of("mode", state.mode(), "since", String.valueOf(state.since())) : null);
        return b;
    }

    private static ResponseEntity<Map<String, Object>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", Map.of("code", "NOT_FOUND", "message", "No route")));
    }
}
