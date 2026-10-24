package com.sentinelcloud.bloodbank.event;

/** Outbound shape of the envelope — payload is Object here since every publish call supplies its own concrete DTO/Map. */
public record OutgoingEvent(
    String eventId,
    String eventType,
    String occurredAt,
    String sourceService,
    String correlationId,
    Object payload
) {}
