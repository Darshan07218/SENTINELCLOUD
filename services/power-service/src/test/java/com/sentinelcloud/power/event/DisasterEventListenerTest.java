package com.sentinelcloud.power.event;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.dto.SubstationDtos.SubstationResponse;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.service.RiskForecastService;
import com.sentinelcloud.power.service.SubstationService;
import com.sentinelcloud.power.service.TransformerRiskForecaster;
import com.sentinelcloud.power.service.TransformerService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Exercises DisasterEventListener.onDisasterEvent() directly (no
 * Spring context, no real broker) — same approach and rationale as
 * blood-bank-service's identical test class. Also specifically
 * verifies the at-risk-transformer roll-up, since that's the one
 * piece of logic in this listener that isn't just a pass-through to
 * an already-tested service method.
 */
class DisasterEventListenerTest {

    private SubstationService substationService;
    private TransformerService transformerService;
    private EventPublisher eventPublisher;
    private RiskForecastService riskForecastService;
    private DisasterEventListener listener;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        substationService = mock(SubstationService.class);
        transformerService = mock(TransformerService.class);
        eventPublisher = mock(EventPublisher.class);
        riskForecastService = mock(RiskForecastService.class);
        listener = new DisasterEventListener(substationService, transformerService, eventPublisher, new EventMetrics(new SimpleMeterRegistry()), riskForecastService);
    }

    private EventEnvelope envelopeFor(String disasterId, double lat, double lng, Double radiusKm) {
        var fields = new java.util.LinkedHashMap<String, Object>();
        fields.put("disasterId", disasterId);
        fields.put("type", "EARTHQUAKE");
        fields.put("severity", "CRITICAL");
        fields.put("latitude", lat);
        fields.put("longitude", lng);
        if (radiusKm != null) fields.put("radiusKm", radiusKm);
        JsonNode payload = objectMapper.valueToTree(fields);
        return new EventEnvelope(UUID.randomUUID().toString(), "disaster.detected", "2026-01-01T00:00:00Z", "disaster-service", disasterId, payload);
    }

    @Test
    void reactsByCallingFindNearbyWithTheDisastersLocationAndRadius() {
        String disasterId = UUID.randomUUID().toString();
        when(substationService.findNearby(18.5, 73.8, 40.0)).thenReturn(List.of());

        listener.onDisasterEvent(envelopeFor(disasterId, 18.5, 73.8, 40.0));

        verify(substationService).findNearby(18.5, 73.8, 40.0);
    }

    @Test
    void countsOnlyWarningOrWorseTransformersAsAtRisk() {
        String disasterId = UUID.randomUUID().toString();
        UUID substationId = UUID.randomUUID();
        SubstationResponse substation = new SubstationResponse(substationId, "Test Substation", "Addr", 18.5, 73.8, "Zone", null, 3.1, null, null);
        when(substationService.findNearby(anyDouble(), anyDouble(), anyDouble())).thenReturn(List.of(substation));

        Transformer normal = new Transformer(substationId, "TXF-1", "Normal", 33.0, 400.0, LocalDate.now());
        Transformer warning = new Transformer(substationId, "TXF-2", "Warning", 33.0, 400.0, LocalDate.now());
        warning.setStatus(InfraStatus.WARNING);
        Transformer failed = new Transformer(substationId, "TXF-3", "Failed", 33.0, 400.0, LocalDate.now());
        failed.setStatus(InfraStatus.FAILED);
        // Saved transformers always have a database-generated id, and the
        // reaction payload includes it (Map.of rejects null values).
        for (Transformer t : List.of(normal, warning, failed)) ReflectionTestUtils.setField(t, "id", UUID.randomUUID());
        when(transformerService.listForSubstation(substationId)).thenReturn(List.of(normal, warning, failed));

        listener.onDisasterEvent(envelopeFor(disasterId, 18.5, 73.8, 25.0));

        ArgumentCaptor<Object> payloadCaptor = ArgumentCaptor.forClass(Object.class);
        verify(eventPublisher).publish(eq(EventRoutingKeys.POWER_INFRASTRUCTURE_AT_RISK), eq(disasterId), payloadCaptor.capture());

        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) payloadCaptor.getValue();
        assertEquals(2L, payload.get("totalAtRiskTransformerCount"), "only the WARNING and FAILED transformers should count as at-risk, not the NORMAL one");
    }

    /** Phase 20: a transformer whose risk forecast scores 50+ is reported even while it is still NORMAL. */
    @Test
    void listsTransformersTheRiskForecastFlagsHighestScoreFirst() {
        String disasterId = UUID.randomUUID().toString();
        UUID substationId = UUID.randomUUID();
        SubstationResponse substation = new SubstationResponse(substationId, "Test Substation", "Addr", 18.5, 73.8, "Zone", null, 3.1, null, null);
        when(substationService.findNearby(anyDouble(), anyDouble(), anyDouble())).thenReturn(List.of(substation));
        Transformer calm = new Transformer(substationId, "TXF-CALM", "Calm", 33.0, 400.0, LocalDate.now());
        Transformer heating = new Transformer(substationId, "TXF-HOT", "Heating", 33.0, 400.0, LocalDate.now());
        Transformer worse = new Transformer(substationId, "TXF-WORSE", "Worse", 33.0, 400.0, LocalDate.now());
        Transformer broken = new Transformer(substationId, "TXF-ERR", "Forecast fails", 33.0, 400.0, LocalDate.now());
        for (Transformer t : List.of(calm, heating, worse, broken)) ReflectionTestUtils.setField(t, "id", UUID.randomUUID());
        when(transformerService.listForSubstation(substationId)).thenReturn(List.of(calm, heating, worse, broken));
        when(riskForecastService.forecast(eq(calm.getId()), anyInt())).thenReturn(risk(calm, 12));
        when(riskForecastService.forecast(eq(heating.getId()), anyInt())).thenReturn(risk(heating, 55));
        when(riskForecastService.forecast(eq(worse.getId()), anyInt())).thenReturn(risk(worse, 81));
        when(riskForecastService.forecast(eq(broken.getId()), anyInt())).thenThrow(new IllegalStateException("db down"));

        listener.onDisasterEvent(envelopeFor(disasterId, 18.5, 73.8, 25.0));

        ArgumentCaptor<Object> payloadCaptor = ArgumentCaptor.forClass(Object.class);
        verify(eventPublisher).publish(eq(EventRoutingKeys.POWER_INFRASTRUCTURE_AT_RISK), eq(disasterId), payloadCaptor.capture());
        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) payloadCaptor.getValue();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> flagged = (List<Map<String, Object>>) payload.get("forecastAtRiskTransformers");
        assertEquals(List.of("TXF-WORSE", "TXF-HOT"), flagged.stream().map(m -> m.get("code")).toList(), "score >= 50 only, highest first; a failing forecast is skipped");
        assertEquals("NORMAL", flagged.get(0).get("status"));
        assertEquals(0L, payload.get("totalAtRiskTransformerCount"), "none is failing yet");
    }

    private static RiskForecastService.TransformerRisk risk(Transformer t, int score) {
        var forecast = new TransformerRiskForecaster.RiskForecast("OK", score, score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : "LOW", 24, 10, 10.0,
            null, null, 0, 0.0, List.of(), List.of());
        return new RiskForecastService.TransformerRisk(t.getId(), t.getCode(), t.getName(), t.getSubstationId(), "Test Substation", "NORMAL", null, null, forecast);
    }

    @Test
    void dropsAnEventWithNoCorrelationIdOrDisasterIdRatherThanPublishingAMalformedReaction() {
        JsonNode payload = objectMapper.valueToTree(Map.of("type", "EARTHQUAKE", "latitude", 18.5, "longitude", 73.8));
        EventEnvelope envelope = new EventEnvelope(UUID.randomUUID().toString(), "disaster.detected", "2026-01-01T00:00:00Z", "disaster-service", null, payload);

        listener.onDisasterEvent(envelope);

        verifyNoInteractions(substationService, transformerService, eventPublisher);
    }
}
