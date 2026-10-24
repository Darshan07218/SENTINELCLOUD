package com.sentinelcloud.power.chaos;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Phase 11 — while this pod is in a simulated failure, every request
 * gets 503 BEFORE Spring Security or any controller runs. That's what a
 * hung process looks like from the outside.
 *
 * Two exceptions:
 *  - /health/** — the actuator probes answer from Spring's own
 *    availability state, which ChaosController set to BROKEN /
 *    REFUSING_TRAFFIC. So Kubernetes sees genuine probe failures, not
 *    just this filter.
 *  - /internal/chaos — so resilience-service can still clear the fault
 *    during cleanup.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ChaosFilter extends OncePerRequestFilter {

    private final ChaosState state;

    public ChaosFilter(ChaosState state) {
        this.state = state;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !state.isFaulty() || path.startsWith("/health") || path.equals("/internal/chaos");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
        response.setContentType("application/json");
        response.getWriter().write(
            "{\"error\":{\"code\":\"SIMULATED_FAILURE\",\"message\":\"power-service pod " + ChaosState.podName()
                + " is in a simulated failure state (Resilience Demo).\"},\"pod\":\"" + ChaosState.podName() + "\"}");
    }
}
