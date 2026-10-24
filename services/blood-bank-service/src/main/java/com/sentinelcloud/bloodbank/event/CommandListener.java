package com.sentinelcloud.bloodbank.event;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sentinelcloud.bloodbank.dto.ReservationDtos.CreateReservationRequest;
import com.sentinelcloud.bloodbank.entity.BloodReservation;
import com.sentinelcloud.bloodbank.exception.ConflictException;
import com.sentinelcloud.bloodbank.exception.NotFoundException;
import com.sentinelcloud.bloodbank.service.ReservationService;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Phase 15: executes response-service's blood commands
 * (docs/PHASE-15-RESPONSE-ENGINE.md §3) with the same ReservationService the
 * REST API uses:
 *
 *   command.blood.reserve  → reserveBlood(bank, {type, units, hospital, notes}) → { reservationId, … }
 *   command.blood.release  → releaseReservation(id) (undo); already released counts as done
 *
 * Exactly-once effect on at-least-once delivery, like the Node executors'
 * commands.js: the command id goes into processed_commands IN THE SAME
 * TRANSACTION as the reservation, so a redelivered command finds it and
 * resends the stored reply instead of reserving twice. A business failure
 * (not enough stock, unknown bank) is recorded in its own transaction,
 * because the failed reservation's transaction is already marked
 * rollback-only. The reply is published after commit; if that fails the
 * listener throws, the message is retried and the stored reply resent.
 */
@Component
public class CommandListener {

    /** Recorded as the requester when an auto-approved plan has no human approver. */
    static final UUID SYSTEM_USER_ID = new UUID(0L, 0L);
    private static final Pattern UUID_RE = Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    private final ReservationService reservationService;
    private final EventPublisher eventPublisher;
    private final EventMetrics eventMetrics;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final ObjectMapper objectMapper;

    public CommandListener(ReservationService reservationService, EventPublisher eventPublisher, EventMetrics eventMetrics,
                           JdbcTemplate jdbc, PlatformTransactionManager transactionManager, ObjectMapper objectMapper) {
        this.reservationService = reservationService;
        this.eventPublisher = eventPublisher;
        this.eventMetrics = eventMetrics;
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(transactionManager);
        this.objectMapper = objectMapper;
    }

    @RabbitListener(queues = EventQueues.BLOODBANK_COMMANDS)
    public void onCommand(EventEnvelope envelope) {
        long started = System.nanoTime();
        try {
            handle(envelope);
            eventMetrics.recordConsumed(EventQueues.BLOODBANK_COMMANDS, envelope, "success", started);
        } catch (RuntimeException e) {
            eventMetrics.recordConsumed(EventQueues.BLOODBANK_COMMANDS, envelope, "error", started);
            throw e;
        }
    }

    /** One command's outcome: what is stored and replied. */
    record Reply(String outcome, Map<String, Object> body) {}

    void handle(EventEnvelope envelope) {
        // Commands change real stock: only response-service may send them.
        if (!EventRoutingKeys.COMMAND_SOURCE.equals(envelope.sourceService())) {
            System.err.printf("[blood-bank-service] ignoring %s from '%s' (only %s may send commands)%n",
                clean(envelope.eventType()), clean(envelope.sourceService()), EventRoutingKeys.COMMAND_SOURCE);
            return;
        }
        JsonNode p = envelope.payload();
        String commandIdText = p == null ? null : p.path("commandId").asText(null);
        if (commandIdText == null || !UUID_RE.matcher(commandIdText).matches()) {
            System.err.printf("[blood-bank-service] ignoring %s without a UUID commandId%n", clean(envelope.eventType()));
            return;
        }
        UUID commandId = UUID.fromString(commandIdText);
        String planId = p.path("planId").asText(null);
        String command = envelope.eventType();

        Reply prior = storedReply(commandId);
        if (prior != null) {
            sendReply(command, commandId, planId, prior);
            return;
        }

        Reply reply;
        try {
            reply = tx.execute(status -> {
                // Claim the command first: a concurrent duplicate waits on this
                // row and then sees it, instead of reserving a second time.
                int claimed = jdbc.update(
                    "INSERT INTO processed_commands (command_id, command, outcome) VALUES (?, ?, 'succeeded') ON CONFLICT (command_id) DO NOTHING",
                    commandId, command);
                if (claimed == 0) return null;
                Map<String, Object> result = execute(command, p);
                jdbc.update("UPDATE processed_commands SET result = ?::jsonb WHERE command_id = ?", toJson(result), commandId);
                return new Reply("succeeded", result);
            });
        } catch (ConflictException | NotFoundException | IllegalArgumentException e) {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("code", e instanceof ConflictException ce ? ce.getCode() : e instanceof NotFoundException ? "NOT_FOUND" : "INVALID_COMMAND");
            error.put("message", e.getMessage());
            Reply failed = new Reply("failed", error);
            tx.executeWithoutResult(status -> jdbc.update(
                "INSERT INTO processed_commands (command_id, command, outcome, result) VALUES (?, ?, 'failed', ?::jsonb) ON CONFLICT (command_id) DO NOTHING",
                commandId, command, toJson(error)));
            reply = failed;
        }
        if (reply == null) reply = storedReply(commandId); // a duplicate finished first
        if (reply != null) sendReply(command, commandId, planId, reply);
        System.out.printf("[blood-bank-service] %s %s: %s%n", clean(command), commandId, reply == null ? "in progress elsewhere" : reply.outcome());
    }

    private Map<String, Object> execute(String command, JsonNode p) {
        if (EventRoutingKeys.COMMAND_BLOOD_RESERVE.equals(command)) {
            UUID bankId = requireUuid(p, "bloodBankId");
            UUID hospitalId = requireUuid(p, "hospitalId");
            String requestedByText = p.path("requestedBy").asText("");
            UUID requestedBy = UUID_RE.matcher(requestedByText).matches() ? UUID.fromString(requestedByText) : SYSTEM_USER_ID;
            int units = p.path("units").asInt(0);
            if (units < 1 || units > 500) throw new IllegalArgumentException("units must be 1..500");
            String notes = p.path("notes").asText("Response plan reservation");
            CreateReservationRequest req = new CreateReservationRequest(
                p.path("bloodType").asText(""), units, hospitalId, notes.length() > 500 ? notes.substring(0, 500) : notes);
            // BloodType.parse inside rejects an invalid type with IllegalArgumentException.
            BloodReservation r = reservationService.reserveBlood(bankId, req, requestedBy);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("reservationId", r.getId().toString());
            result.put("batchId", r.getBatchId().toString());
            result.put("bloodBankId", bankId.toString());
            result.put("bloodType", req.bloodType());
            result.put("units", r.getUnitsReserved());
            result.put("hospitalId", hospitalId.toString());
            return result;
        }
        if (EventRoutingKeys.COMMAND_BLOOD_RELEASE.equals(command)) {
            UUID reservationId = requireUuid(p, "reservationId");
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("reservationId", reservationId.toString());
            try {
                reservationService.releaseReservation(reservationId);
                result.put("released", true);
            } catch (ConflictException e) {
                // Released or fulfilled meanwhile: nothing left to undo.
                if (!"RESERVATION_NOT_ACTIVE".equals(e.getCode())) throw e;
                result.put("released", false);
                result.put("alreadyClosed", true);
            }
            return result;
        }
        throw new IllegalArgumentException("unknown command " + clean(command));
    }

    private Reply storedReply(UUID commandId) {
        List<Reply> rows = jdbc.query(
            "SELECT outcome, result::text AS result FROM processed_commands WHERE command_id = ? AND result IS NOT NULL",
            (rs, i) -> new Reply(rs.getString("outcome"), fromJson(rs.getString("result"))), commandId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private void sendReply(String command, UUID commandId, String planId, Reply reply) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("commandId", commandId.toString());
        payload.put("command", command);
        payload.put("planId", planId);
        payload.put("succeeded".equals(reply.outcome()) ? "result" : "error", reply.body());
        eventPublisher.publish(
            "succeeded".equals(reply.outcome()) ? EventRoutingKeys.COMMAND_SUCCEEDED : EventRoutingKeys.COMMAND_FAILED,
            commandId.toString(), payload);
    }

    private static UUID requireUuid(JsonNode p, String field) {
        String value = p.path(field).asText("");
        if (!UUID_RE.matcher(value).matches()) throw new IllegalArgumentException(field + " must be a UUID");
        return UUID.fromString(value);
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> fromJson(String json) {
        try {
            return objectMapper.readValue(json, Map.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String clean(String s) {
        return s == null ? "null" : s.replaceAll("[^A-Za-z0-9._-]", "?").substring(0, Math.min(60, s.length()));
    }
}
