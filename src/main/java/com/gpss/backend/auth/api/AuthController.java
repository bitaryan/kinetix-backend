package com.gpss.backend.auth.api;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.gpss.backend.auth.application.AuthService;
import com.gpss.backend.auth.application.AuthService.IssuedTokens;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.auth.web.AccessTokenData;
import com.gpss.backend.auth.web.CreateUserRequest;
import com.gpss.backend.auth.web.LoginData;
import com.gpss.backend.auth.web.LoginRequest;
import com.gpss.backend.auth.web.MessageData;
import com.gpss.backend.auth.web.UserProfileDto;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.common.api.ApiResponse;
import com.gpss.backend.config.AppProperties;
import com.gpss.backend.security.CurrentPrincipal;
import com.gpss.backend.security.RateLimiter;
import com.gpss.backend.security.RefreshCookie;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;

@RestController
@Validated
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;
    private final AppProperties properties;
    private final RateLimiter rateLimiter;

    public AuthController(AuthService authService, AppProperties properties, RateLimiter rateLimiter) {
        this.authService = authService;
        this.properties = properties;
        this.rateLimiter = rateLimiter;
    }

    @PostMapping("/login")
    public ApiResponse<LoginData> login(
            @Valid @RequestBody LoginRequest payload,
            HttpServletRequest request,
            HttpServletResponse response) {
        rateLimiter.enforceLogin(request);
        IssuedTokens issued = authService.login(
                payload, request.getHeader("User-Agent"), rateLimiter.clientIp(request));
        RefreshCookie.set(response, properties, issued.refreshToken());
        return ApiResponse.ok(new LoginData(
                issued.accessToken(),
                "bearer",
                properties.accessTokenExpireSeconds(),
                UserProfileDto.from(issued.user())));
    }

    @PostMapping("/refresh")
    public ApiResponse<AccessTokenData> refresh(HttpServletRequest request, HttpServletResponse response) {
        rateLimiter.enforceRefresh(request);
        String refresh = cookieValue(request);
        if (refresh == null || refresh.isBlank()) {
            throw new ApiException(401, "INVALID_REFRESH_TOKEN", "Refresh token is missing");
        }
        IssuedTokens issued = authService.refresh(refresh, request.getHeader("User-Agent"));
        RefreshCookie.set(response, properties, issued.refreshToken());
        return ApiResponse.ok(new AccessTokenData(
                issued.accessToken(), "bearer", properties.accessTokenExpireSeconds()));
    }

    @PostMapping("/logout")
    public ApiResponse<MessageData> logout(HttpServletResponse response) {
        CurrentPrincipal principal = CurrentPrincipal.require();
        authService.logout(principal.sessionId());
        RefreshCookie.clear(response, properties);
        return ApiResponse.ok(new MessageData("Successfully logged out"));
    }

    @PostMapping("/logout-all")
    public ApiResponse<MessageData> logoutAll(HttpServletResponse response) {
        CurrentPrincipal principal = CurrentPrincipal.require();
        authService.logoutAll(principal.user().getId());
        RefreshCookie.clear(response, properties);
        return ApiResponse.ok(new MessageData("Successfully logged out from all devices"));
    }

    @GetMapping("/me")
    public ApiResponse<UserProfileDto> me() {
        return ApiResponse.ok(UserProfileDto.from(CurrentPrincipal.require().user()));
    }

    @PostMapping("/users")
    public ResponseEntity<ApiResponse<UserProfileDto>> createUser(@Valid @RequestBody CreateUserRequest payload) {
        CurrentPrincipal.require().requireRoles(UserRole.ADMIN);
        var user = authService.createUser(payload, false);
        return ResponseEntity.status(HttpStatus.CREATED).body(ApiResponse.ok(UserProfileDto.from(user)));
    }

    private static String cookieValue(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie cookie : cookies) {
            if (RefreshCookie.NAME.equals(cookie.getName())) {
                return cookie.getValue();
            }
        }
        return null;
    }
}
