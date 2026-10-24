package com.sentinelcloud.bloodbank.event;

import com.fasterxml.jackson.databind.JsonNode;
import com.sentinelcloud.bloodbank.dto.BloodBankDtos.BloodBankResponse;
import com.sentinelcloud.bloodbank.dto.MiscDtos.ShortageAlert;
import com.sentinelcloud.bloodbank.service.AlertService;
import com.sentinelcloud.bloodbank.service.BloodBankService;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Phase 7 reaction: "Blood Service checks inventory and generates
 * shortage alerts." Consumes q.bloodbank.disaster-events
 * (disaster.detected / disaster.updated) and reuses the EXACT same
 * business logic the REST API already exposes — BloodBankService.findNearby
 * (GET /blood-banks/near) for "which blood banks are near this point,"
 * and AlertService.generateAlerts (GET /blood-banks/alerts) for the
 * network-wide low-stock/expiring-soon shortage feed — then publishes
 * blood.shortage.detected with the disaster's id as correlationId.
 *
 * The shortage alert list is network-wide rather than scoped to only
 * the nearby blood banks: a disaster's response effort may need to
 * pull blood FROM banks outside the immediate radius, so knowing
 * about a shortage anywhere in the network is relevant to disaster
 * response, not just shortages at the handful of banks physically
 * close to the epicenter.
 */
@Component
public class DisasterEventListener {

    private final BloodBankService bloodBankService;
    private final AlertService alertService;
    private final EventPublisher eventPublisher;
    private final EventMetrics eventMetrics;

    public DisasterEventListener(BloodBankService bloodBankService, AlertService alertService, EventPublisher eventPublisher,
                                 EventMetrics eventMetrics) {
        this.eventMetrics = eventMetrics;
        this.bloodBankService = bloodBankService;
        this.alertService = alertService;
        this.eventPublisher = eventPublisher;
    }

    /**
     * Phase 10: thin timing wrapper — records sentinel_events_consumed_total,
     * sentinel_event_handler_seconds and sentinel_event_processing_seconds
     * (see EventMetrics), then rethrows failures unchanged so Spring AMQP's
     * error handling behaves exactly as before.
     */
    @RabbitListener(queues = EventQueues.BLOODBANK_DISASTER_EVENTS)
    public void onDisasterEvent(EventEnvelope envelope) {
        long started = System.nanoTime();
        try {
            handle(envelope);
            eventMetrics.recordConsumed(EventQueues.BLOODBANK_DISASTER_EVENTS, envelope, "success", started);
        } catch (RuntimeException e) {
            eventMetrics.recordConsumed(EventQueues.BLOODBANK_DISASTER_EVENTS, envelope, "error", started);
            throw e;
        }
    }

    private void handle(EventEnvelope envelope) {
        // Phase 12: events are input like any other. Drop (and log, safely)
        // anything malformed instead of throwing a NullPointerException or
        // running an unbounded radius query.
        JsonNode payload = envelope.payload();
        if (payload == null || !payload.isObject()) {
            System.err.printf("[blood-bank-service] dropping %s event: no payload%n", clean(envelope.eventType()));
            return;
        }
        String disasterId = envelope.correlationId() != null ? envelope.correlationId() : textOrNull(payload, "disasterId");
        if (disasterId == null || !UUID_PATTERN.matcher(disasterId).matches()) {
            System.err.printf("[blood-bank-service] dropping %s event with no valid correlationId/disasterId (eventId=%s)%n", clean(envelope.eventType()), clean(envelope.eventId()));
            return;
        }
        double latitude = payload.path("latitude").asDouble(Double.NaN);
        double longitude = payload.path("longitude").asDouble(Double.NaN);
        double radiusKm = payload.hasNonNull("radiusKm") ? payload.get("radiusKm").asDouble(Double.NaN) : EventRoutingKeys.DEFAULT_REACTION_RADIUS_KM;
        if (!(latitude >= -90 && latitude <= 90) || !(longitude >= -180 && longitude <= 180) || !(radiusKm > 0 && radiusKm <= MAX_RADIUS_KM)) {
            System.err.printf("[blood-bank-service] dropping %s event for disaster %s: coordinates or radius out of range%n", clean(envelope.eventType()), disasterId);
            return;
        }

        System.out.printf("[blood-bank-service] reacting to %s for disaster %s (%s, %s)%n",
            clean(envelope.eventType()), disasterId, clean(textOrNull(payload, "type")), clean(textOrNull(payload, "severity")));

        List<BloodBankResponse> nearbyBloodBanks = bloodBankService.findNearby(latitude, longitude, radiusKm);
        // Only shortages at the banks that can actually serve this disaster
        // (the nearby ones) — a low-stock alert 400 km away is not part of
        // this disaster's situation report.
        java.util.Set<UUID> nearbyIds = nearbyBloodBanks.stream().map(BloodBankResponse::id).collect(Collectors.toSet());
        List<ShortageAlert> shortageAlerts = alertService.generateAlerts().stream()
            .filter(a -> nearbyIds.contains(a.bloodBankId()))
            .collect(Collectors.toList());

        Map<String, Object> reactionPayload = Map.ofEntries(
            Map.entry("disasterId", disasterId),
            Map.entry("searchRadiusKm", radiusKm),
            Map.entry("nearbyBloodBankCount", nearbyBloodBanks.size()),
            Map.entry("nearbyBloodBanks", nearbyBloodBanks.stream()
                .map(b -> Map.of("id", b.id(), "name", b.name(), "distanceKm", b.distanceKm()))
                .collect(Collectors.toList())),
            Map.entry("shortageAlertCount", shortageAlerts.size()),
            Map.entry("shortageAlerts", shortageAlerts.stream()
                .map(a -> Map.of(
                    "severity", a.severity().name(),
                    "type", a.type(),
                    "bloodBankName", a.bloodBankName(),
                    "bloodType", a.bloodType(),
                    "message", a.message()))
                .collect(Collectors.toList()))
        );

        eventPublisher.publish(EventRoutingKeys.BLOOD_SHORTAGE_DETECTED, disasterId, reactionPayload);

        System.out.printf("[blood-bank-service] published blood.shortage.detected for disaster %s: %d nearby banks, %d shortage alerts%n",
            disasterId, nearbyBloodBanks.size(), shortageAlerts.size());
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
