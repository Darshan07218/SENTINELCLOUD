package com.sentinelcloud.power.event;

public record OutgoingEvent(
    String eventId,
    String eventType,
    String occurredAt,
    String sourceService,
    String correlationId,
    Object payload
) {}
