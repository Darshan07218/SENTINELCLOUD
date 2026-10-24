package com.sentinelcloud.power.event;

import com.fasterxml.jackson.databind.JsonNode;

/** The canonical event envelope (docs/ARCHITECTURE.md section 4.2) — see blood-bank-service's identical class for full rationale. */
public record EventEnvelope(
    String eventId,
    String eventType,
    String occurredAt,
    String sourceService,
    String correlationId,
    JsonNode payload
) {}
