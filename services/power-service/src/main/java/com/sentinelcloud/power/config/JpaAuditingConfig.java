package com.sentinelcloud.power.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;

/**
 * Enables @CreatedDate/@LastModifiedDate auditing, used on every
 * entity in this service — same rationale as
 * blood-bank-service's identical config class. The DB trigger in the
 * migrations (set_updated_at()) is kept too, as a backstop for rows
 * touched outside the JPA layer.
 */
@Configuration
@EnableJpaAuditing
public class JpaAuditingConfig {
}
