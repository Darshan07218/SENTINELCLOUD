package com.sentinelcloud.power.event;

/** Mirrors services/*-service/src/events/eventTypes.js's ROUTING_KEYS exactly (see docs/ARCHITECTURE.md section 4). */
public final class EventRoutingKeys {
    private EventRoutingKeys() {}

    public static final String EXCHANGE_NAME = "sentinelcloud.events";
    /** Phase 14: where rejected messages go (see broker.js in the Node services). */
    public static final String DEAD_LETTER_EXCHANGE = "sentinelcloud.dlx";

    public static final String DISASTER_DETECTED = "disaster.detected";
    public static final String DISASTER_UPDATED = "disaster.updated";
    public static final String HOSPITAL_CAPACITY_UPDATED = "hospital.capacity.updated";
    public static final String AMBULANCE_STATUS_UPDATED = "ambulance.status.updated";
    public static final String BLOOD_SHORTAGE_DETECTED = "blood.shortage.detected";
    public static final String POWER_INFRASTRUCTURE_AT_RISK = "power.infrastructure.at_risk";

    public static final double DEFAULT_REACTION_RADIUS_KM = 25.0;
}
