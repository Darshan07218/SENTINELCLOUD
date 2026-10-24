package com.sentinelcloud.bloodbank.event;

import org.springframework.amqp.AmqpException;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Publishes reaction events onto the shared topic exchange, wrapped
 * in the same envelope shape every Node service's broker.js
 * publishEvent() produces (see that file for the full rationale on
 * correlationId — it's what lets disaster-service's situation-report
 * aggregator, and the live dashboard, group this reaction back to the
 * disaster.detected event that triggered it).
 */
@Component
public class EventPublisher {

    /** Phase 14: how long to wait for RabbitMQ's publisher confirm. */
    static final long CONFIRM_TIMEOUT_SECONDS = 5;

    private final RabbitTemplate rabbitTemplate;
    private final EventMetrics eventMetrics;

    public EventPublisher(RabbitTemplate rabbitTemplate, EventMetrics eventMetrics) {
        this.rabbitTemplate = rabbitTemplate;
        this.eventMetrics = eventMetrics;
    }

    public void publish(String routingKey, String correlationId, Object payload) {
        OutgoingEvent event = new OutgoingEvent(
            UUID.randomUUID().toString(),
            routingKey,
            // Millisecond precision, like every Node publisher (Instant.now()
            // can print microseconds, which some consumers' date parsers reject).
            Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS).toString(),
            "blood-bank-service",
            correlationId,
            payload
        );
        // Phase 14: wait for the broker's confirm. Throwing here fails the
        // listener that triggered this reaction, so the incoming event is
        // retried and, if it keeps failing, dead-lettered — never lost.
        CorrelationData confirm = new CorrelationData(event.eventId());
        rabbitTemplate.convertAndSend(EventRoutingKeys.EXCHANGE_NAME, routingKey, event, message -> {
            message.getMessageProperties().setMessageId(event.eventId());
            return message;
        }, confirm);
        awaitConfirm(confirm, routingKey);
        eventMetrics.recordPublished(routingKey); // Phase 10: sentinel_events_published_total
    }

    static void awaitConfirm(CorrelationData confirm, String routingKey) {
        try {
            CorrelationData.Confirm result = confirm.getFuture().get(CONFIRM_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!result.isAck()) {
                throw new AmqpException("RabbitMQ rejected " + routingKey + ": " + result.getReason());
            }
        } catch (TimeoutException e) {
            throw new AmqpException("no publisher confirm for " + routingKey + " within " + CONFIRM_TIMEOUT_SECONDS + " s", e);
        } catch (ExecutionException e) {
            throw new AmqpException("publishing " + routingKey + " failed", e.getCause());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AmqpException("interrupted while waiting for the confirm of " + routingKey, e);
        }
    }
}
