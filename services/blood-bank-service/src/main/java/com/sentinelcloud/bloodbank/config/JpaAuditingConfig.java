package com.sentinelcloud.bloodbank.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;

/**
 * Enables Spring Data JPA's {@code @CreatedDate}/{@code @LastModifiedDate}
 * auditing annotations, used on every entity in this service instead
 * of relying purely on the database trigger in the migrations to keep
 * updated_at accurate. The DB trigger (see V1__create_blood_banks_and_inventory.sql)
 * is kept too, as a backstop for any row touched outside the JPA layer
 * — but the entity object returned from a save() call would otherwise
 * show a stale updated_at until re-fetched, which this avoids.
 */
@Configuration
@EnableJpaAuditing
public class JpaAuditingConfig {
}
