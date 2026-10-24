package com.sentinelcloud.power.config;

import com.sentinelcloud.power.security.JsonAuthenticationEntryPoint;
import com.sentinelcloud.power.security.JwtAuthenticationFilter;
import com.sentinelcloud.power.security.JwtService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * Stateless JWT-based security, identical shape to
 * blood-bank-service's SecurityConfig. @PreAuthorize on controller
 * methods (via @EnableMethodSecurity) does the actual role checks;
 * this class only wires up authentication and which paths skip it.
 */
@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http, JwtService jwtService) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
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
