package com.sentinelcloud.power.service;

import com.sentinelcloud.power.domain.InfraStatus;
import com.sentinelcloud.power.dto.TransformerDtos.TelemetryRequest;
import com.sentinelcloud.power.entity.Transformer;
import com.sentinelcloud.power.entity.TransformerReading;
import com.sentinelcloud.power.repository.TransformerFailureEventRepository;
import com.sentinelcloud.power.repository.TransformerReadingRepository;
import com.sentinelcloud.power.repository.TransformerRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class TelemetryServiceTest {

    private TransformerRepository transformerRepository;
    private TransformerReadingRepository readingRepository;
    private TransformerFailureEventRepository failureEventRepository;
    private TelemetryService telemetryService;

    private final UUID transformerId = UUID.randomUUID();
    private Transformer transformer;

    @BeforeEach
    void setUp() {
        transformerRepository = mock(TransformerRepository.class);
        readingRepository = mock(TransformerReadingRepository.class);
        failureEventRepository = mock(TransformerFailureEventRepository.class);
        telemetryService = new TelemetryService(transformerRepository, readingRepository, failureEventRepository, new AnomalyDetectionService());

        transformer = new Transformer(UUID.randomUUID(), "TXF-01", "Test Transformer", 33.0, 400.0, null);
        when(transformerRepository.findById(transformerId)).thenReturn(Optional.of(transformer));
        // Reflectively-inaccessible id field isn't settable from a test without JPA — repository
        // lookups in this service always go through findById, so the UUID here is what matters,
        // not the entity's own (null, pre-persist) id.
        when(readingRepository.save(any(TransformerReading.class))).thenAnswer(inv -> inv.getArgument(0));
        when(transformerRepository.save(any(Transformer.class))).thenAnswer(inv -> inv.getArgument(0));
    }

    @Test
    void aReadingWellWithinRatedBoundsResultsInNormalStatusAndNoAnomaly() {
        when(readingRepository.findByTransformerIdOrderByRecordedAtDesc(eq(transformerId), any())).thenReturn(List.of());

        var result = telemetryService.recordTelemetry(transformerId, new TelemetryRequest(33.0, 400.0, 55.0, 40.0, null), UUID.randomUUID());

        assertEquals("NORMAL", result.status());
        assertFalse(result.anomalyDetected());
        assertEquals(InfraStatus.NORMAL, transformer.getStatus());
    }

    @Test
    void anOverloadedReadingDrivesStatusToCriticalAndOpensAFailureEvent() {
        when(readingRepository.findByTransformerIdOrderByRecordedAtDesc(eq(transformerId), any())).thenReturn(List.of());

        var result = telemetryService.recordTelemetry(transformerId,
            new TelemetryRequest(33.0, 400.0, ThresholdEngine.LOAD_CRITICAL_PCT, 40.0, null), UUID.randomUUID());

        assertEquals("CRITICAL", result.status());
        assertTrue(result.anomalyDetected());
        assertTrue(result.statusChanged());
        verify(failureEventRepository, times(1)).save(any());
    }

    @Test
    void recoveringFromCriticalBackToNormalResolvesTheOpenFailureEvent() {
        transformer.applyTelemetrySnapshot(33.0, 400.0, ThresholdEngine.LOAD_CRITICAL_PCT, 40.0, java.time.Instant.now(), InfraStatus.CRITICAL);
        when(readingRepository.findByTransformerIdOrderByRecordedAtDesc(eq(transformerId), any())).thenReturn(List.of());
        var openEvent = new com.sentinelcloud.power.entity.TransformerFailureEvent(transformerId, InfraStatus.NORMAL, InfraStatus.CRITICAL, "prior breach", null);
        when(failureEventRepository.findByTransformerIdAndResolvedAtIsNull(transformerId)).thenReturn(List.of(openEvent));

        var result = telemetryService.recordTelemetry(transformerId, new TelemetryRequest(33.0, 400.0, 55.0, 40.0, null), UUID.randomUUID());

        assertEquals("NORMAL", result.status());
        assertNotNull(openEvent.getResolvedAt(), "recovering out of CRITICAL should resolve the open failure event");
    }

    @Test
    void escalatingFromCriticalToFailedDoesNotOpenASecondFailureEvent() {
        transformer.applyTelemetrySnapshot(33.0, 400.0, ThresholdEngine.LOAD_CRITICAL_PCT, 40.0, java.time.Instant.now(), InfraStatus.CRITICAL);

        telemetryService.setStatus(transformerId, new com.sentinelcloud.power.dto.TransformerDtos.SetStatusRequest("FAILED", "breaker tripped"), UUID.randomUUID());

        assertEquals(InfraStatus.FAILED, transformer.getStatus());
        verify(failureEventRepository, never()).save(any());
    }

    @Test
    void aBackdatedReadingIsStoredButDoesNotOverwriteTheLiveSnapshot() {
        java.time.Instant latest = java.time.Instant.now().minusSeconds(60);
        transformer.applyTelemetrySnapshot(33.0, 400.0, 55.0, 40.0, latest, InfraStatus.NORMAL);
        when(readingRepository.findByTransformerIdOrderByRecordedAtDesc(eq(transformerId), any())).thenReturn(List.of());

        var result = telemetryService.recordTelemetry(transformerId,
            new TelemetryRequest(33.0, 400.0, ThresholdEngine.LOAD_CRITICAL_PCT, 40.0, latest.minusSeconds(3600)), UUID.randomUUID());

        assertEquals("NORMAL", result.status());
        assertFalse(result.statusChanged());
        assertEquals(latest, transformer.getLastReadingAt());
        verify(readingRepository, times(1)).save(any());
        verify(failureEventRepository, never()).save(any());
    }

    @Test
    void aStatisticallyAnomalousButRatedRangeReadingUpgradesStatusFromNormalToWarning() {
        // Tight prior history around 33.0kV — a jump to 36.0kV is comfortably inside
        // ThresholdEngine's 10% rated-value warning band (33 * 1.10 = 36.3) but is many
        // standard deviations away from this transformer's own stable baseline.
        List<TransformerReading> history = List.of(
            reading(32.9), reading(33.0), reading(33.1), reading(32.95), reading(33.05), reading(33.0)
        );
        when(readingRepository.findByTransformerIdOrderByRecordedAtDesc(eq(transformerId), any())).thenReturn(history);

        var result = telemetryService.recordTelemetry(transformerId, new TelemetryRequest(36.0, 400.0, 55.0, 40.0, null), UUID.randomUUID());

        assertEquals("WARNING", result.status());
        assertTrue(result.anomalyDetected());
    }

    private TransformerReading reading(double voltage) {
        return new TransformerReading(transformerId, voltage, 400.0, 55.0, 40.0, false, null, java.time.Instant.now());
    }
}
