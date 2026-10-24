package com.sentinelcloud.power.event;

public final class EventQueues {
    private EventQueues() {}

    public static final String POWER_DISASTER_EVENTS = "q.power.disaster-events";
    /** Phase 14: every service's dead letters, bound to the dead-letter exchange with "#". */
    public static final String DEAD_LETTERS = "q.dead-letters";
}
