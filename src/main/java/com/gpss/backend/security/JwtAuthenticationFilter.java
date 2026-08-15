package com.gpss.backend.security;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.gpss.backend.auth.domain.ActiveSession;
import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.infra.ActiveSessionRepository;
import com.gpss.backend.auth.infra.UserRepository;
import com.gpss.backend.common.api.ApiError;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.common.api.ApiResponse;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtService jwtService;
    private final ActiveSessionRepository sessions;
    private final UserRepository users;
    private final ObjectMapper objectMapper;

    public JwtAuthenticationFilter(
            JwtService jwtService,
            ActiveSessionRepository sessions,
            UserRepository users,
            ObjectMapper objectMapper) {
        this.jwtService = jwtService;
        this.sessions = sessions;
        this.users = users;
        this.objectMapper = objectMapper;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        if (isPublic(request)) {
            filterChain.doFilter(request, response);
            return;
        }
        try {
            String header = request.getHeader("Authorization");
            if (header == null || !header.regionMatches(true, 0, "Bearer ", 0, 7)) {
                throw new ApiException(401, "UNAUTHORIZED", "A bearer access token is required");
            }
            String token = header.substring(7).strip();
            JwtService.AccessTokenClaims claims = jwtService.decodeAccessToken(token);
            ActiveSession session = sessions.findById(claims.sessionId()).orElse(null);
            if (session == null
                    || !session.getUserId().equals(claims.userId())
                    || session.isRevoked()
                    || !session.getExpiresAt().isAfter(Instant.now())) {
                throw new ApiException(401, "UNAUTHORIZED", "Access session is no longer active");
            }
            User user = users.findById(claims.userId()).orElse(null);
            if (user == null || !user.isActive()) {
                throw new ApiException(401, "UNAUTHORIZED", "User account is unavailable");
            }
            CurrentPrincipal principal = new CurrentPrincipal(user, session.getId());
            UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken(
                            principal,
                            null,
                            List.of(new SimpleGrantedAuthority("ROLE_" + user.getRole().name())));
            SecurityContextHolder.getContext().setAuthentication(authentication);
            filterChain.doFilter(request, response);
        } catch (ApiException ex) {
            writeError(response, ex);
        }
    }

    private static boolean isPublic(HttpServletRequest request) {
        if (HttpMethod.OPTIONS.matches(request.getMethod())) {
            return true;
        }
        String path = request.getRequestURI();
        if ("/health".equals(path) && HttpMethod.GET.matches(request.getMethod())) {
            return true;
        }
        if ("/api/v1/auth/login".equals(path) && HttpMethod.POST.matches(request.getMethod())) {
            return true;
        }
        if ("/api/v1/auth/refresh".equals(path) && HttpMethod.POST.matches(request.getMethod())) {
            return true;
        }
        return path.startsWith("/ws");
    }

    private void writeError(HttpServletResponse response, ApiException ex) throws IOException {
        response.setStatus(ex.getStatus().value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(
                response.getOutputStream(),
                new ApiResponse<>(false, null, new ApiError(ex.getCode(), ex.getMessage())));
    }
}
