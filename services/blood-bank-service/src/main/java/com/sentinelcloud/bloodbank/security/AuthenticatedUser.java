package com.sentinelcloud.bloodbank.security;

import java.util.UUID;

/** The verified caller, extracted from the JWT and used as the Spring Security principal. */
public record AuthenticatedUser(UUID id, String email, String role) {
}
