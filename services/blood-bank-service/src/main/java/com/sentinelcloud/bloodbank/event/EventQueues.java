package com.sentinelcloud.bloodbank.event;

public final class EventQueues {
    private EventQueues() {}

    public static final String BLOODBANK_DISASTER_EVENTS = "q.bloodbank.disaster-events";
    /** Phase 15: response-service's blood commands (reserve / release). */
    public static final String BLOODBANK_COMMANDS = "q.bloodbank.commands";
    /** Phase 14: every service's dead letters, bound to the dead-letter exchange with "#". */
    public static final String DEAD_LETTERS = "q.dead-letters";
}
