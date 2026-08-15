package com.gpss.backend.security;

import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;

import com.gpss.backend.config.AppProperties;

import jakarta.servlet.http.HttpServletResponse;

public final class RefreshCookie {

    public static final String NAME = "refresh_token";

    private RefreshCookie() {}

    public static void set(HttpServletResponse response, AppProperties properties, String token) {
        response.addHeader(HttpHeaders.SET_COOKIE, cookie(properties, token, properties.refreshCookieMaxAgeSeconds()).toString());
    }

    public static void clear(HttpServletResponse response, AppProperties properties) {
        response.addHeader(HttpHeaders.SET_COOKIE, cookie(properties, "", 0).toString());
    }

    private static ResponseCookie cookie(AppProperties properties, String value, long maxAge) {
        String sameSite = properties.getCookie().getSameSite();
        String capitalized = sameSite.substring(0, 1).toUpperCase() + sameSite.substring(1).toLowerCase();
        return ResponseCookie.from(NAME, value)
                .httpOnly(true)
                .secure(properties.getCookie().isSecure())
                .sameSite(capitalized)
                .path(properties.refreshCookiePath())
                .maxAge(maxAge)
                .build();
    }
}
