package com.sentinelcloud.power.domain;

/**
 * Health status of a transformer (and, by roll-up, a substation — see
 * service/AlertService.java for how substation-level severity is
 * derived from its worst transformer).
 *
 * NORMAL: within rated operating bounds.
 * WARNING: one or more readings mildly outside rated bounds, or a
 *          statistically unusual reading vs. this transformer's own
 *          history — worth watching, not yet an emergency.
 * CRITICAL: a reading materially outside rated bounds (overloaded,
 *           overheating, over/under-voltage) — needs attention soon.
 * FAILED: either explicitly marked failed/offline by an
 *         INFRASTRUCTURE_ADMIN, or a reading breached a
 *         protective-shutdown-level threshold (see
 *         service/ThresholdEngine.java FAILURE_* constants).
 */
public enum InfraStatus {
    NORMAL, WARNING, CRITICAL, FAILED;

    /** Ordinal-independent severity ranking, used to roll many transformers up to one substation status. */
    public int severityRank() {
        return switch (this) {
            case NORMAL -> 0;
            case WARNING -> 1;
            case CRITICAL -> 2;
            case FAILED -> 3;
        };
    }

    public static InfraStatus worstOf(InfraStatus a, InfraStatus b) {
        return a.severityRank() >= b.severityRank() ? a : b;
    }
}
