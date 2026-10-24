package com.sentinelcloud.bloodbank.config;

import com.sentinelcloud.bloodbank.security.JsonAuthenticationEntryPoint;
import com.sentinelcloud.bloodbank.security.JwtAuthenticationFilter;
import com.sentinelcloud.bloodbank.security.JwtService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Stateless JWT-based security (no sessions, no cookies — every
 * request must carry a valid Bearer token). @PreAuthorize on
 * controller methods (enabled via @EnableMethodSecurity) is where the
 * actual role checks happen; this class only wires up authentication
 * (JwtAuthenticationFilter) and which paths need it at all.
 */
@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http, JwtService jwtService) throws Exception {
        http
            .csrf(csrf -> csrf.disable()) // stateless token-based API, no cookies to protect against CSRF
            .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .exceptionHandling(eh -> eh.authenticationEntryPoint(new JsonAuthenticationEntryPoint()))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/health", "/health/**", "/prometheus", "/info").permitAll()
                // Phase 11: fault injection — authenticated by X-Chaos-Token in ChaosController
                // (not a user JWT), and never reachable through the gateway.
                .requestMatchers("/internal/**").permitAll()
                .requestMatchers("/swagger-ui/**", "/v3/api-docs/**", "/swagger-ui.html").permitAll()
                .anyRequest().authenticated()
            )
            .addFilterBefore(new JwtAuthenticationFilter(jwtService), UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }
}
