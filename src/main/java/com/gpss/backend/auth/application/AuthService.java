package com.gpss.backend.auth.application;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.gpss.backend.auth.domain.ActiveSession;
import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.auth.infra.ActiveSessionRepository;
import com.gpss.backend.auth.infra.UserRepository;
import com.gpss.backend.auth.web.CreateUserRequest;
import com.gpss.backend.auth.web.LoginRequest;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.config.AppProperties;
import com.gpss.backend.security.JwtService;

@Service
public class AuthService {

    private static final int MAX_LOGIN_ATTEMPTS = 5;
    private static final Duration LOCKOUT = Duration.ofMinutes(15);

    private final UserRepository users;
    private final ActiveSessionRepository sessions;
    private final JwtService jwtService;
    private final AppProperties properties;

    public AuthService(
            UserRepository users,
            ActiveSessionRepository sessions,
            JwtService jwtService,
            AppProperties properties) {
        this.users = users;
        this.sessions = sessions;
        this.jwtService = jwtService;
        this.properties = properties;
    }

    @Transactional
    public User createUser(CreateUserRequest payload, boolean allowAdminRole) {
        if (!payload.passwordComplexEnough()) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
        UserRole role = payload.resolvedRole();
        if (role == UserRole.ADMIN && !allowAdminRole) {
            throw new ApiException(
                    HttpStatus.FORBIDDEN,
                    "FORBIDDEN",
                    "Administrator accounts can only be created through the bootstrap script");
        }
        if (users.findByEmployeeId(payload.normalizedEmployeeId()).isPresent()) {
            throw new ApiException(
                    409, "EMPLOYEE_ID_EXISTS", "An account with this employee ID already exists");
        }
        if (users.findByEmail(payload.normalizedEmail()).isPresent()) {
            throw new ApiException(409, "EMAIL_EXISTS", "An account with this email already exists");
        }
        User user = new User();
        user.setEmployeeId(payload.normalizedEmployeeId());
        user.setEmployeeName(payload.normalizedName());
        user.setEmail(payload.normalizedEmail());
        user.setPasswordHash(jwtService.hashPassword(payload.password()));
        user.setRole(role);
        user.setActive(true);
        return users.save(user);
    }

    @Transactional(noRollbackFor = ApiException.class)
    public IssuedTokens login(LoginRequest payload, String userAgent, String ipAddress) {
        User user = users.findByEmployeeIdForUpdate(payload.normalizedEmployeeId()).orElse(null);
        if (user == null) {
            jwtService.verifyDummyPassword(payload.password());
            throw invalidCredentials();
        }
        Instant now = Instant.now();
        if (user.getLockedUntil() != null && user.getLockedUntil().isAfter(now)) {
            jwtService.verifyDummyPassword(payload.password());
            throw invalidCredentials();
        }
        if (user.getLockedUntil() != null && !user.getLockedUntil().isAfter(now)) {
            user.setNoOfAttempts(0);
            user.setLockedUntil(null);
        }
        if (!user.isActive()) {
            jwtService.verifyDummyPassword(payload.password());
            throw invalidCredentials();
        }
        if (!jwtService.verifyPassword(payload.password(), user.getPasswordHash())) {
            registerFailedAttempt(user, now);
            throw invalidCredentials();
        }
        if (user.getRole() != payload.role()) {
            registerFailedAttempt(user, now);
            throw invalidCredentials();
        }
        user.setNoOfAttempts(0);
        user.setLockedUntil(null);
        user.setLastLoginAt(now);
        sessions.revokeForUser(user.getId());
        String refreshToken = jwtService.generateRefreshToken();
        ActiveSession session = new ActiveSession();
        session.setUserId(user.getId());
        session.setRefreshTokenHash(jwtService.hashRefreshToken(refreshToken));
        session.setUserAgent(userAgent);
        session.setIpAddress(ipAddress);
        session.setExpiresAt(now.plus(Duration.ofDays(properties.getJwt().getRefreshTokenExpireDays())));
        sessions.save(session);
        String access = jwtService.createAccessToken(user.getId(), session.getId(), user.getRole());
        return new IssuedTokens(access, refreshToken, user);
    }

    @Transactional(noRollbackFor = ApiException.class)
    public IssuedTokens refresh(String refreshToken, String userAgent) {
        String tokenHash = jwtService.hashRefreshToken(refreshToken);
        ActiveSession session = sessions.findByRefreshTokenHashForUpdate(tokenHash).orElse(null);
        Instant now = Instant.now();
        if (session == null) {
            sessions.findByPreviousRefreshTokenHashForUpdate(tokenHash).ifPresent(reused -> {
                sessions.revokeForUser(reused.getUserId());
            });
            throw new ApiException(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
        }
        if (session.isRevoked() || !session.getExpiresAt().isAfter(now)) {
            if (!session.isRevoked()) {
                session.setRevoked(true);
            }
            throw new ApiException(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
        }
        User user = users.findById(session.getUserId()).orElse(null);
        if (user == null || !user.isActive()) {
            session.setRevoked(true);
            throw new ApiException(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
        }
        String rotated = jwtService.generateRefreshToken();
        session.setPreviousRefreshTokenHash(session.getRefreshTokenHash());
        session.setRefreshTokenHash(jwtService.hashRefreshToken(rotated));
        session.setUserAgent(userAgent);
        session.setExpiresAt(now.plus(Duration.ofDays(properties.getJwt().getRefreshTokenExpireDays())));
        String access = jwtService.createAccessToken(user.getId(), session.getId(), user.getRole());
        return new IssuedTokens(access, rotated, user);
    }

    @Transactional
    public void logout(UUID sessionId) {
        sessions.findById(sessionId).ifPresent(session -> session.setRevoked(true));
    }

    @Transactional
    public void logoutAll(UUID userId) {
        sessions.revokeForUser(userId);
    }

    private void registerFailedAttempt(User user, Instant now) {
        user.setNoOfAttempts(user.getNoOfAttempts() + 1);
        if (user.getNoOfAttempts() >= MAX_LOGIN_ATTEMPTS) {
            user.setLockedUntil(now.plus(LOCKOUT));
        }
    }

    private static ApiException invalidCredentials() {
        return new ApiException(401, "INVALID_CREDENTIALS", "Invalid user ID or password");
    }

    public record IssuedTokens(String accessToken, String refreshToken, User user) {}
}
