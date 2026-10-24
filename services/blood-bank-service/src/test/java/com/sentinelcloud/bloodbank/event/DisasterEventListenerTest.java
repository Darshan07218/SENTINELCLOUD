package com.sentinelcloud.bloodbank.event;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sentinelcloud.bloodbank.dto.BloodBankDtos.BloodBankResponse;
import com.sentinelcloud.bloodbank.dto.MiscDtos.AlertSeverity;
import com.sentinelcloud.bloodbank.dto.MiscDtos.ShortageAlert;
import com.sentinelcloud.bloodbank.service.AlertService;
import com.sentinelcloud.bloodbank.service.BloodBankService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Exercises DisasterEventListener.onDisasterEvent() directly (calling
 * the @RabbitListener-annotated method as a plain Java method — no
 * Spring context, no real broker) to verify it correctly extracts the
 * disaster's location from the incoming envelope, calls into the
 * SAME business logic the REST API uses, and builds a
 * well-formed reaction payload. This test caught a real bug during
 * development: an early version's Map.of(...) call for the reaction
 * payload had 6 key/value pairs, exceeding Map.of's 5-pair overload
 * and failing to compile — see the fix using Map.ofEntries(...).
 */
class DisasterEventListenerTest {

    private BloodBankService bloodBankService;
    private AlertService alertService;
    private EventPublisher eventPublisher;
    private DisasterEventListener listener;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        bloodBankService = mock(BloodBankService.class);
        alertService = mock(AlertService.class);
        eventPublisher = mock(EventPublisher.class);
        listener = new DisasterEventListener(bloodBankService, alertService, eventPublisher, new EventMetrics(new SimpleMeterRegistry()));
    }

    private EventEnvelope envelopeFor(String disasterId, double lat, double lng, Double radiusKm) throws Exception {
        var payloadFields = new java.util.LinkedHashMap<String, Object>();
        payloadFields.put("disasterId", disasterId);
        payloadFields.put("type", "FLOOD");
        payloadFields.put("severity", "HIGH");
        payloadFields.put("latitude", lat);
        payloadFields.put("longitude", lng);
        if (radiusKm != null) payloadFields.put("radiusKm", radiusKm);
        JsonNode payload = objectMapper.valueToTree(payloadFields);
        return new EventEnvelope(UUID.randomUUID().toString(), "disaster.detected", "2026-01-01T00:00:00Z", "disaster-service", disasterId, payload);
    }

    @Test
    void reactsByCallingFindNearbyWithTheDisastersLocationAndRadius() throws Exception {
        String disasterId = UUID.randomUUID().toString();
        when(bloodBankService.findNearby(18.5, 73.8, 30.0)).thenReturn(List.of());
        when(alertService.generateAlerts()).thenReturn(List.of());

        listener.onDisasterEvent(envelopeFor(disasterId, 18.5, 73.8, 30.0));

        verify(bloodBankService).findNearby(18.5, 73.8, 30.0);
    }

    @Test
    void fallsBackToDefaultRadiusWhenPayloadOmitsIt() throws Exception {
        String disasterId = UUID.randomUUID().toString();
        when(bloodBankService.findNearby(anyDouble(), anyDouble(), eq(EventRoutingKeys.DEFAULT_REACTION_RADIUS_KM))).thenReturn(List.of());
        when(alertService.generateAlerts()).thenReturn(List.of());

        listener.onDisasterEvent(envelopeFor(disasterId, 18.5, 73.8, null));

        verify(bloodBankService).findNearby(anyDouble(), anyDouble(), eq(EventRoutingKeys.DEFAULT_REACTION_RADIUS_KM));
    }

    @Test
    void publishesAReactionPayloadWithNearbyBanksAndShortageAlertsUnderTheDisastersCorrelationId() throws Exception {
        String disasterId = UUID.randomUUID().toString();
        BloodBankResponse bank = new BloodBankResponse(UUID.randomUUID(), "Test Bank", "Addr", 18.5, 73.8, "123", null, 4.2, null, null);
        ShortageAlert alert = new ShortageAlert(AlertSeverity.CRITICAL, "LOW_STOCK", bank.id(), "Test Bank", "O_NEGATIVE", "Critically low O-", 2, null);
        // A shortage at a bank outside the disaster radius is not part of this reaction.
        ShortageAlert farAway = new ShortageAlert(AlertSeverity.CRITICAL, "LOW_STOCK", UUID.randomUUID(), "Far Bank", "A+", "Critically low A+", 0, null);
        when(bloodBankService.findNearby(anyDouble(), anyDouble(), anyDouble())).thenReturn(List.of(bank));
        when(alertService.generateAlerts()).thenReturn(List.of(alert, farAway));

        listener.onDisasterEvent(envelopeFor(disasterId, 18.5, 73.8, 20.0));

        ArgumentCaptor<String> routingKeyCaptor = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> correlationIdCaptor = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Object> payloadCaptor = ArgumentCaptor.forClass(Object.class);
        verify(eventPublisher).publish(routingKeyCaptor.capture(), correlationIdCaptor.capture(), payloadCaptor.capture());

        assertEquals(EventRoutingKeys.BLOOD_SHORTAGE_DETECTED, routingKeyCaptor.getValue());
        assertEquals(disasterId, correlationIdCaptor.getValue(), "correlationId must be the disaster's own id so the situation report can group this reaction");

        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) payloadCaptor.getValue();
        assertEquals(1, payload.get("nearbyBloodBankCount"));
        assertEquals(1, payload.get("shortageAlertCount"));
    }

    @Test
    void dropsAnEventWithNoCorrelationIdOrDisasterIdRatherThanPublishingAMalformedReaction() throws Exception {
        JsonNode payload = objectMapper.valueToTree(Map.of("type", "FLOOD", "latitude", 18.5, "longitude", 73.8));
        EventEnvelope envelope = new EventEnvelope(UUID.randomUUID().toString(), "disaster.detected", "2026-01-01T00:00:00Z", "disaster-service", null, payload);

        listener.onDisasterEvent(envelope);

        verifyNoInteractions(bloodBankService, alertService, eventPublisher);
    }
}
