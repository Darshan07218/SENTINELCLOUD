package com.sentinelcloud.power.event;

import org.junit.jupiter.api.Test;
import org.springframework.amqp.AmqpException;
import org.springframework.amqp.rabbit.connection.CorrelationData;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Phase 14: a reaction counts as published only once RabbitMQ confirms it. */
class EventPublisherConfirmTest {

    @Test
    void anAckedPublishReturnsNormally() {
        CorrelationData confirm = new CorrelationData("e1");
        confirm.getFuture().complete(new CorrelationData.Confirm(true, null));
        assertDoesNotThrow(() -> EventPublisher.awaitConfirm(confirm, "x.y"));
    }

    @Test
    void aNackedPublishThrowsSoTheIncomingEventIsRetried() {
        CorrelationData confirm = new CorrelationData("e2");
        confirm.getFuture().complete(new CorrelationData.Confirm(false, "queue full"));
        AmqpException e = assertThrows(AmqpException.class, () -> EventPublisher.awaitConfirm(confirm, "x.y"));
        assertTrue(e.getMessage().contains("queue full"));
    }

    @Test
    void aFailedConfirmThrows() {
        CorrelationData confirm = new CorrelationData("e3");
        confirm.getFuture().completeExceptionally(new IllegalStateException("channel closed"));
        assertThrows(AmqpException.class, () -> EventPublisher.awaitConfirm(confirm, "x.y"));
    }
}