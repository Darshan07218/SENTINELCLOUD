package com.sentinelcloud.power.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jws;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Verifies access tokens issued by auth-service. Same shared-secret
 * HS256 approach as every other service in this project — see
 * blood-bank-service's identical class for the full rationale.
 * JWT_ACCESS_SECRET must match auth-service, the gateway, and every
 * other service that independently re-verifies tokens.
 */
@Component
public class JwtService {

    private final String rawSecret;
    private SecretKey signingKey;

    public JwtService(@Value("${security.jwt.access-secret}") String rawSecret) {
        this.rawSecret = rawSecret;
    }

    @PostConstruct
    void init() {
        if (rawSecret == null || rawSecret.isBlank()) {
            throw new IllegalStateException(
                "security.jwt.access-secret (JWT_ACCESS_SECRET) must be set — refusing to start without it.");
        }
        // Phase 12: same startup rule as the Node services (security/secrets.js):
        // at least 32 characters and not an example value.
        if (rawSecret.length() < 32 || rawSecret.matches("(?i).*(change[_-]?me|placeholder|dev[_-]?only).*")) {
            throw new IllegalStateException(
                "JWT_ACCESS_SECRET is too short or still an example value. Generate secrets with scripts/generate-secrets.sh (see SECURITY.md).");
        }
        this.signingKey = Keys.hmacShaKeyFor(rawSecret.getBytes(StandardCharsets.UTF_8));
    }

    public AuthenticatedUser verify(String token) {
        try {
            Jws<Claims> jws = Jwts.parser()
                .verifyWith(signingKey)
                .requireIssuer("sentinelcloud-auth-service")
                .build()
                .parseSignedClaims(token);
            // Phase 12: exactly the algorithm auth-service signs with.
            if (!"HS256".equals(jws.getHeader().getAlgorithm())) {
                throw new JwtException("Unexpected signing algorithm");
            }
            Claims claims = jws.getPayload();

            String type = claims.get("type", String.class);
            if (!"access".equals(type)) {
                throw new JwtException("Not an access token");
            }

            UUID id = UUID.fromString(claims.getSubject());
            String email = claims.get("email", String.class);
            String role = claims.get("role", String.class);
            // Phase 12: a token without a known role is not a usable identity
            // (it used to become the authority "ROLE_null").
            if (role == null || !KNOWN_ROLES.contains(role)) {
                throw new JwtException("Token has no valid role");
            }
            return new AuthenticatedUser(id, email, role);
        } catch (JwtException | IllegalArgumentException e) {
            throw new InvalidTokenException("Invalid or expired access token", e);
        }
    }

    private static final java.util.Set<String> KNOWN_ROLES = java.util.Set.of(
        "CITIZEN", "EMERGENCY_OPERATOR", "HOSPITAL_ADMIN", "INFRASTRUCTURE_ADMIN", "SYSTEM_ADMIN");

    public static class InvalidTokenException extends RuntimeException {
        public InvalidTokenException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
