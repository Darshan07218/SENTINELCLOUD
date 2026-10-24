package com.sentinelcloud.bloodbank.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;

import java.io.IOException;
import java.util.Map;

/**
 * Handles the case JwtAuthenticationFilter doesn't: a request with NO
 * Authorization header at all reaching a protected endpoint. The
 * filter only writes a JSON error when an INVALID token is presented;
 * a completely absent token isn't a filter-level rejection, it's an
 * authorization-level one (SecurityConfig's `.anyRequest().authenticated()`),
 * which Spring Security routes through this entry point. Without this
 * class, that path would fall back to a bare 401 with no body — this
 * keeps the same {@code { error: { code, message } } } JSON shape
 * every other error response in this API uses.
 */
public class JsonAuthenticationEntryPoint implements AuthenticationEntryPoint {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response, AuthenticationException authException) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json");
        Map<String, Object> body = Map.of(
            "error", Map.of("code", "UNAUTHENTICATED", "message", "Missing or malformed Authorization header.")
        );
        response.getWriter().write(objectMapper.writeValueAsString(body));
    }
}
