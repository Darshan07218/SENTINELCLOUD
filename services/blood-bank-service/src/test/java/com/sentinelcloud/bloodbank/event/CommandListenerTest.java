package com.sentinelcloud.bloodbank.event;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sentinelcloud.bloodbank.dto.ReservationDtos.CreateReservationRequest;
import com.sentinelcloud.bloodbank.entity.BloodReservation;
import com.sentinelcloud.bloodbank.exception.ConflictException;
import com.sentinelcloud.bloodbank.service.ReservationService;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Phase 15: blood commands from response-service run once and always get a reply. */
class CommandListenerTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private ReservationService reservationService;
    private EventPublisher eventPublisher;
    private JdbcTemplate jdbc;
    private CommandListener listener;

    private final UUID commandId = UUID.randomUUID();
    private final UUID bankId = UUID.randomUUID();
    private final UUID hospitalId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        reservationService = mock(ReservationService.class);
        eventPublisher = mock(EventPublisher.class);
        jdbc = mock(JdbcTemplate.class);
        PlatformTransactionManager tm = mock(PlatformTransactionManager.class);
        when(tm.getTransaction(any())).thenReturn(mock(TransactionStatus.class));
        listener = new CommandListener(reservationService, eventPublisher, new EventMetrics(new SimpleMeterRegistry()), jdbc, tm, mapper);
        // No stored reply unless a test says so; the claim INSERT succeeds.
        when(jdbc.query(anyString(), any(RowMapper.class), any(Object[].class))).thenReturn(List.of());
        when(jdbc.update(startsWith("INSERT INTO processed_commands"), any(Object[].class))).thenReturn(1);
    }

    private EventEnvelope reserve(String source) {
        ObjectNode p = mapper.createObjectNode();
        p.put("commandId", commandId.toString());
        p.put("planId", UUID.randomUUID().toString());
        p.put("bloodBankId", bankId.toString());
        p.put("hospitalId", hospitalId.toString());
        p.put("bloodType", "O-");
        p.put("units", 4);
        p.put("requestedBy", UUID.randomUUID().toString());
        return new EventEnvelope(UUID.randomUUID().toString(), EventRoutingKeys.COMMAND_BLOOD_RESERVE, "2026-10-24T00:00:00Z", source, commandId.toString(), p);
    }

    @Test
    void ignoresCommandsNotSentByResponseService() {
        listener.handle(reserve("hospital-service"));
        verifyNoInteractions(reservationService, eventPublisher);
    }

    @Test
    @SuppressWarnings("unchecked")
    void reservesOnceAndRepliesSucceededWithTheReservationId() {
        BloodReservation r = new BloodReservation(UUID.randomUUID(), hospitalId, 4, "n", UUID.randomUUID());
        UUID reservationId = UUID.randomUUID();
        ReflectionTestUtils.setField(r, "id", reservationId);
        when(reservationService.reserveBlood(eq(bankId), any(CreateReservationRequest.class), any(UUID.class))).thenReturn(r);

        listener.handle(reserve("response-service"));

        verify(reservationService, times(1)).reserveBlood(eq(bankId), any(CreateReservationRequest.class), any(UUID.class));
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(eventPublisher).publish(eq(EventRoutingKeys.COMMAND_SUCCEEDED), eq(commandId.toString()), payload.capture());
        Map<String, Object> body = (Map<String, Object>) payload.getValue();
        assertEquals(commandId.toString(), body.get("commandId"));
        assertEquals(reservationId.toString(), ((Map<String, Object>) body.get("result")).get("reservationId"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void aRedeliveredCommandResendsTheStoredReplyWithoutReservingAgain() {
        CommandListener.Reply stored = new CommandListener.Reply("succeeded", Map.of("reservationId", "r-1"));
        when(jdbc.query(anyString(), any(RowMapper.class), any(Object[].class))).thenReturn(List.of(stored));

        listener.handle(reserve("response-service"));

        verifyNoInteractions(reservationService);
        verify(eventPublisher).publish(eq(EventRoutingKeys.COMMAND_SUCCEEDED), eq(commandId.toString()), any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void notEnoughStockIsAFailedReplyNotARetry() {
        when(reservationService.reserveBlood(any(), any(), any())).thenThrow(new ConflictException("INSUFFICIENT_INVENTORY", "No single batch of O- has 4 available units."));

        assertDoesNotThrow(() -> listener.handle(reserve("response-service")));

        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(eventPublisher).publish(eq(EventRoutingKeys.COMMAND_FAILED), eq(commandId.toString()), payload.capture());
        Map<String, Object> error = (Map<String, Object>) ((Map<String, Object>) payload.getValue()).get("error");
        assertEquals("INSUFFICIENT_INVENTORY", error.get("code"));
        // The failure itself is recorded, so a redelivery replays it.
        verify(jdbc).update(contains("'failed'"), any(Object[].class));
    }
}
