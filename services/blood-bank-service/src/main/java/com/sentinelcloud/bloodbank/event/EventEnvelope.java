package com.sentinelcloud.bloodbank.event;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The canonical event envelope every service on the bus publishes and
 * consumes (docs/ARCHITECTURE.md section 4.2): eventId, eventType,
 * occurredAt, sourceService, correlationId, payload. payload is kept
 * as a raw JsonNode rather than a concrete type because this ONE
 * listener (DisasterEventListener) only ever needs to read
 * disaster.detected/disaster.updated payloads, and typing it that way
 * avoids needing a separate DTO class per event type this service
 * will never publish. Jackson deserializes incoming AMQP messages
 * straight into this record via the Jackson2JsonMessageConverter bean
 * (see config/RabbitConfig.java).
 */
public record EventEnvelope(
    String eventId,
    String eventType,
    String occurredAt,
    String sourceService,
    String correlationId,
    JsonNode payload
) {}
