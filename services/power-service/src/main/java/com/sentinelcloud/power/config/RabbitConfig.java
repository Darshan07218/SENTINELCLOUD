package com.sentinelcloud.power.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sentinelcloud.power.event.EventQueues;
import com.sentinelcloud.power.event.EventRoutingKeys;
import org.springframework.amqp.core.*;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Declares this service's side of the shared topic exchange — see
 * blood-bank-service's identical RabbitConfig for the full rationale.
 * q.power.disaster-events binds only to disaster.detected/updated;
 * this service only ever reacts to disasters, never to other
 * services' reaction events.
 */
@Configuration
public class RabbitConfig {

    @Bean
    public TopicExchange eventsExchange() {
        return new TopicExchange(EventRoutingKeys.EXCHANGE_NAME, true, false);
    }

    @Bean
    public Queue powerDisasterEventsQueue() {
        return new Queue(EventQueues.POWER_DISASTER_EVENTS, true);
    }

    @Bean
    public Binding bindDisasterDetected(Queue powerDisasterEventsQueue, TopicExchange eventsExchange) {
        return BindingBuilder.bind(powerDisasterEventsQueue).to(eventsExchange).with(EventRoutingKeys.DISASTER_DETECTED);
    }

    @Bean
    public Binding bindDisasterUpdated(Queue powerDisasterEventsQueue, TopicExchange eventsExchange) {
        return BindingBuilder.bind(powerDisasterEventsQueue).to(eventsExchange).with(EventRoutingKeys.DISASTER_UPDATED);
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

    @Bean
    public MessageConverter jsonMessageConverter(ObjectMapper objectMapper) {
        return new Jackson2JsonMessageConverter(objectMapper);
    }
}
