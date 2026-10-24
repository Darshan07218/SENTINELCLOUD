package com.sentinelcloud.power.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * Reads the Bearer token (if any), and if valid, populates the
 * SecurityContext with an AuthenticatedUser principal and a single
 * ROLE_&lt;role&gt; authority (backs @PreAuthorize checks). Identical
 * to blood-bank-service's filter — see that class for full rationale.
 */
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtService jwtService;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public JwtAuthenticationFilter(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest request, @NonNull HttpServletResponse response,
                                     @NonNull FilterChain filterChain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");

        if (header != null && header.startsWith("Bearer ")) {
            String token = header.substring("Bearer ".length());
            try {
                AuthenticatedUser user = jwtService.verify(token);
                var authority = new SimpleGrantedAuthority("ROLE_" + user.role());
                var authentication = new UsernamePasswordAuthenticationToken(user, null, List.of(authority));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            } catch (JwtService.InvalidTokenException e) {
                SecurityContextHolder.clearContext();
                writeUnauthenticated(response, e.getMessage());
                return;
            }
        }

        filterChain.doFilter(request, response);
    }

    private void writeUnauthenticated(HttpServletResponse response, String message) throws IOException {
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json");
        Map<String, Object> body = Map.of("error", Map.of("code", "UNAUTHENTICATED", "message", message));
        response.getWriter().write(objectMapper.writeValueAsString(body));
    }
}
