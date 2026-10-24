package com.sentinelcloud.bloodbank.event;

import com.rabbitmq.client.ShutdownSignalException;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import io.micrometer.core.instrument.Timer;
import org.springframework.amqp.rabbit.connection.Connection;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.connection.ConnectionListener;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Phase 10: event-bus metrics with EXACTLY the same Prometheus names,
 * labels and buckets as the Node services' src/metrics.js, so a single
 * dashboard query covers all eight services:
 *
 *   sentinel_events_consumed_total{queue,event_type,outcome}
 *   sentinel_events_published_total{event_type}
 *   sentinel_event_processing_seconds_bucket{queue,event_type,outcome,le}  (publisher occurredAt → handled)
 *   sentinel_event_handler_seconds_bucket{queue,event_type,outcome,le}     (handler run time only)
 *   sentinel_dependency_up{dependency="rabbitmq"}
 *
 * (Micrometer turns "sentinel.events.consumed" into
 * sentinel_events_consumed_total, and a Timer into *_seconds_*.)
 */
@Component
public class EventMetrics {

    /** Same bounds as EVENT_LATENCY_BUCKETS in the Node services' metrics.js. */
    private static final Duration[] EVENT_BUCKETS = {
        Duration.ofMillis(10), Duration.ofMillis(50), Duration.ofMillis(100), Duration.ofMillis(250),
        Duration.ofMillis(500), Duration.ofSeconds(1), Duration.ofMillis(2500), Duration.ofSeconds(5),
        Duration.ofSeconds(10), Duration.ofSeconds(30), Duration.ofSeconds(60)
    };

    private final MeterRegistry registry;
    private final AtomicInteger brokerConnected = new AtomicInteger(0);

    /** Used by Spring: also tracks whether the RabbitMQ connection is currently open. */
    @Autowired
    public EventMetrics(MeterRegistry registry, ConnectionFactory connectionFactory) {
        this(registry);
        connectionFactory.addConnectionListener(new ConnectionListener() {
            @Override
            public void onCreate(Connection connection) {
                brokerConnected.set(1);
            }

            @Override
            public void onClose(Connection connection) {
                brokerConnected.set(0);
            }

            @Override
            public void onShutDown(ShutdownSignalException signal) {
                brokerConnected.set(0);
            }
        });
    }

    /** Used by unit tests (e.g. with a SimpleMeterRegistry) — no broker involved. */
    public EventMetrics(MeterRegistry registry) {
        this.registry = registry;
        Gauge.builder("sentinel.dependency.up", brokerConnected, AtomicInteger::get)
            .description("1 if this service can currently reach the dependency, else 0")
            .tag("dependency", "rabbitmq")
            .register(registry);
    }

    public void recordConsumed(String queue, EventEnvelope envelope, String outcome, long startedNanos) {
        String eventType = envelope.eventType() != null ? envelope.eventType() : "unknown";
        Tags tags = Tags.of("queue", queue, "event_type", eventType, "outcome", outcome);

        Counter.builder("sentinel.events.consumed")
            .description("Events consumed from RabbitMQ, by queue, type and outcome")
            .tags(tags).register(registry).increment();

        Timer.builder("sentinel.event.handler")
            .description("Time this service's handler spent processing one event")
            .tags(tags).serviceLevelObjectives(EVENT_BUCKETS).register(registry)
            .record(System.nanoTime() - startedNanos, TimeUnit.NANOSECONDS);

        // End-to-end latency from the publisher's own timestamp. Negative
        // values (clock skew between pods) are clamped to zero, like the Node side.
        try {
            long millis = Math.max(0, Duration.between(Instant.parse(envelope.occurredAt()), Instant.now()).toMillis());
            Timer.builder("sentinel.event.processing")
                .description("Time from an event being published until this service finished processing it")
                .tags(tags).serviceLevelObjectives(EVENT_BUCKETS).register(registry)
                .record(millis, TimeUnit.MILLISECONDS);
        } catch (RuntimeException unparseableTimestamp) {
            // missing/invalid occurredAt: count the event, skip the latency sample
        }
    }

    public void recordPublished(String eventType) {
        Counter.builder("sentinel.events.published")
            .description("Events published to the sentinelcloud.events exchange, by type")
            .tag("event_type", eventType).register(registry).increment();
    }
}
