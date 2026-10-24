package com.sentinelcloud.power.event;

import com.fasterxml.jackson.databind.JsonNode;
import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.dto.SubstationDtos.SubstationResponse;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.service.SubstationService;
import com.sentinelcloud.power.service.TransformerService;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Phase 7 reaction: "Power Service identifies nearby infrastructure."
 * Consumes q.power.disaster-events (disaster.detected / disaster.updated)
 * and reuses the exact same geo query the REST API already exposes at
 * GET /power/near (SubstationService.findNearby), then enriches each
 * nearby substation with its transformers' current status (reusing
 * TransformerService.listForSubstation — the same data
 * AnalyticsController's /power/map endpoint assembles) so responders
 * know not just WHERE the infrastructure is but whether it's already
 * degraded before the disaster even hit it. Publishes
 * power.infrastructure.at_risk with the disaster's id as correlationId.
 */
@Component
public class DisasterEventListener {

    private final SubstationService substationService;
    private final TransformerService transformerService;
    private final EventPublisher eventPublisher;
    private final EventMetrics eventMetrics;

    public DisasterEventListener(SubstationService substationService, TransformerService transformerService, EventPublisher eventPublisher,
                                 EventMetrics eventMetrics) {
        this.eventMetrics = eventMetrics;
        this.substationService = substationService;
        this.transformerService = transformerService;
        this.eventPublisher = eventPublisher;
    }

    /**
     * Phase 10: thin timing wrapper — records sentinel_events_consumed_total,
     * sentinel_event_handler_seconds and sentinel_event_processing_seconds
     * (see EventMetrics), then rethrows failures unchanged so Spring AMQP's
     * error handling behaves exactly as before.
     */
    @RabbitListener(queues = EventQueues.POWER_DISASTER_EVENTS)
    public void onDisasterEvent(EventEnvelope envelope) {
        long started = System.nanoTime();
        try {
            handle(envelope);
            eventMetrics.recordConsumed(EventQueues.POWER_DISASTER_EVENTS, envelope, "success", started);
        } catch (RuntimeException e) {
            eventMetrics.recordConsumed(EventQueues.POWER_DISASTER_EVENTS, envelope, "error", started);
            throw e;
        }
    }

    private void handle(EventEnvelope envelope) {
        // Phase 12: events are input like any other. Drop (and log, safely)
        // anything malformed instead of throwing a NullPointerException or
        // running an unbounded radius query.
        JsonNode payload = envelope.payload();
        if (payload == null || !payload.isObject()) {
            System.err.printf("[power-service] dropping %s event: no payload%n", clean(envelope.eventType()));
            return;
        }
        String disasterId = envelope.correlationId() != null ? envelope.correlationId() : textOrNull(payload, "disasterId");
        if (disasterId == null || !UUID_PATTERN.matcher(disasterId).matches()) {
            System.err.printf("[power-service] dropping %s event with no valid correlationId/disasterId (eventId=%s)%n", clean(envelope.eventType()), clean(envelope.eventId()));
            return;
        }
        double latitude = payload.path("latitude").asDouble(Double.NaN);
        double longitude = payload.path("longitude").asDouble(Double.NaN);
        double radiusKm = payload.hasNonNull("radiusKm") ? payload.get("radiusKm").asDouble(Double.NaN) : EventRoutingKeys.DEFAULT_REACTION_RADIUS_KM;
        if (!(latitude >= -90 && latitude <= 90) || !(longitude >= -180 && longitude <= 180) || !(radiusKm > 0 && radiusKm <= MAX_RADIUS_KM)) {
            System.err.printf("[power-service] dropping %s event for disaster %s: coordinates or radius out of range%n", clean(envelope.eventType()), disasterId);
            return;
        }

        System.out.printf("[power-service] reacting to %s for disaster %s (%s, %s)%n",
            clean(envelope.eventType()), disasterId, clean(textOrNull(payload, "type")), clean(textOrNull(payload, "severity")));

        List<SubstationResponse> nearbySubstations = substationService.findNearby(latitude, longitude, radiusKm);

        List<Map<String, Object>> substationsWithTransformers = nearbySubstations.stream()
            .map(s -> {
                List<Transformer> transformers = transformerService.listForSubstation(s.id());
                long atRiskCount = transformers.stream()
                    .filter(t -> t.getStatus().severityRank() >= InfraStatus.WARNING.severityRank())
                    .count();
                return Map.<String, Object>ofEntries(
                    Map.entry("id", s.id()),
                    Map.entry("name", s.name()),
                    Map.entry("distanceKm", s.distanceKm()),
                    Map.entry("transformerCount", transformers.size()),
                    Map.entry("atRiskTransformerCount", atRiskCount),
                    Map.entry("transformers", transformers.stream()
                        .map(t -> Map.of("id", t.getId(), "code", t.getCode(), "status", t.getStatus().name()))
                        .collect(Collectors.toList()))
                );
            })
            .collect(Collectors.toList());

        long totalAtRisk = substationsWithTransformers.stream().mapToLong(m -> (long) m.get("atRiskTransformerCount")).sum();

        Map<String, Object> reactionPayload = Map.of(
            "disasterId", disasterId,
            "searchRadiusKm", radiusKm,
            "nearbySubstationCount", nearbySubstations.size(),
            "totalAtRiskTransformerCount", totalAtRisk,
            "nearbySubstations", substationsWithTransformers
        );

        eventPublisher.publish(EventRoutingKeys.POWER_INFRASTRUCTURE_AT_RISK, disasterId, reactionPayload);

        System.out.printf("[power-service] published power.infrastructure.at_risk for disaster %s: %d nearby substations, %d at-risk transformers%n",
            disasterId, nearbySubstations.size(), totalAtRisk);
    }

    private static final java.util.regex.Pattern UUID_PATTERN =
        java.util.regex.Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    private static final double MAX_RADIUS_KM = 500;

    /** Strips control characters (no forged log lines) and caps length. */
    private static String clean(String s) {
        if (s == null) return null;
        String c = s.replaceAll("\\p{Cntrl}", " ");
        return c.length() > 80 ? c.substring(0, 80) + "…" : c;
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
