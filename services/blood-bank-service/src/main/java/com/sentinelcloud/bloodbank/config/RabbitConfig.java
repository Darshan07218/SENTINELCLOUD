package com.sentinelcloud.bloodbank.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sentinelcloud.bloodbank.event.EventQueues;
import com.sentinelcloud.bloodbank.event.EventRoutingKeys;
import org.springframework.amqp.core.*;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Declares this service's side of the shared topic exchange
 * ("sentinelcloud.events") documented in docs/ARCHITECTURE.md section
 * 4 — the exact same exchange every Node service's broker.js
 * connectBroker() asserts. Exchange/queue/binding declaration is
 * idempotent (Spring AMQP's RabbitAdmin auto-declares these on
 * startup and is a no-op if they already exist), so it doesn't matter
 * which service happens to start first.
 *
 * q.bloodbank.disaster-events binds ONLY to disaster.detected and
 * disaster.updated — this service only ever REACTS to disasters, it
 * never listens to the other services' reaction events (that's
 * disaster-service's reaction-aggregator queue's job, and
 * notification-service's wildcard queue's job).
 */
@Configuration
public class RabbitConfig {

    @Bean
    public TopicExchange eventsExchange() {
        return new TopicExchange(EventRoutingKeys.EXCHANGE_NAME, true, false);
    }

    @Bean
    public Queue bloodBankDisasterEventsQueue() {
        return new Queue(EventQueues.BLOODBANK_DISASTER_EVENTS, true);
    }

    @Bean
    public Binding bindDisasterDetected(Queue bloodBankDisasterEventsQueue, TopicExchange eventsExchange) {
        return BindingBuilder.bind(bloodBankDisasterEventsQueue).to(eventsExchange).with(EventRoutingKeys.DISASTER_DETECTED);
    }

    @Bean
    public Binding bindDisasterUpdated(Queue bloodBankDisasterEventsQueue, TopicExchange eventsExchange) {
        return BindingBuilder.bind(bloodBankDisasterEventsQueue).to(eventsExchange).with(EventRoutingKeys.DISASTER_UPDATED);
    }

    // Phase 15: commands from response-service (CommandListener).
    @Bean
    public Queue bloodBankCommandsQueue() {
        return new Queue(EventQueues.BLOODBANK_COMMANDS, true);
    }

    @Bean
    public Binding bindReserveCommand(Queue bloodBankCommandsQueue, TopicExchange eventsExchange) {
        return BindingBuilder.bind(bloodBankCommandsQueue).to(eventsExchange).with(EventRoutingKeys.COMMAND_BLOOD_RESERVE);
    }

    @Bean
    public Binding bindReleaseCommand(Queue bloodBankCommandsQueue, TopicExchange eventsExchange) {
        return BindingBuilder.bind(bloodBankCommandsQueue).to(eventsExchange).with(EventRoutingKeys.COMMAND_BLOOD_RELEASE);
    }

    // Phase 14: the dead-letter exchange and its catch-all queue, declared by
    // every service (like the main exchange) so the "sentinel-dead-letter"
    // policy never points at a missing exchange. Names match broker.js.
    @Bean
    public TopicExchange deadLetterExchange() {
        return new TopicExchange(EventRoutingKeys.DEAD_LETTER_EXCHANGE, true, false);
    }

    @Bean
    public Queue deadLetterQueue() {
        return new Queue(EventQueues.DEAD_LETTERS, true);
    }

    @Bean
    public Binding bindDeadLetters(Queue deadLetterQueue, TopicExchange deadLetterExchange) {
        return BindingBuilder.bind(deadLetterQueue).to(deadLetterExchange).with("#");
    }

    /**
     * JSON (de)serialization for both publishing (RabbitTemplate) and
     * consuming (@RabbitListener) — Spring Boot's AMQP autoconfiguration
     * automatically wires up any single MessageConverter bean into
     * both, so this one bean covers the whole service.
     */
    @Bean
    public MessageConverter jsonMessageConverter(ObjectMapper objectMapper) {
        return new Jackson2JsonMessageConverter(objectMapper);
    }
}
