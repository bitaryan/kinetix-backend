package com.gpss.backend.common.web;

import java.io.IOException;

import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import com.gpss.backend.config.AppProperties;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

@Component
public class SecurityHeadersFilter extends OncePerRequestFilter {

    private final AppProperties properties;

    public SecurityHeadersFilter(AppProperties properties) {
        this.properties = properties;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        setIfAbsent(response, "X-Content-Type-Options", "nosniff");
        setIfAbsent(response, "X-Frame-Options", "DENY");
        setIfAbsent(response, "Referrer-Policy", "no-referrer");
        setIfAbsent(response, "Permissions-Policy", "geolocation=(), microphone=(), camera=()");
        setIfAbsent(response, "Cross-Origin-Opener-Policy", "same-origin");
        setIfAbsent(response, "X-Permitted-Cross-Domain-Policies", "none");
        if (properties.getCookie().isSecure()) {
            setIfAbsent(response, "Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        }
        filterChain.doFilter(request, response);
    }

    private static void setIfAbsent(HttpServletResponse response, String name, String value) {
        if (!response.containsHeader(name)) {
            response.setHeader(name, value);
        }
    }
}
