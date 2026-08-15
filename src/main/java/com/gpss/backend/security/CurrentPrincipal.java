package com.gpss.backend.security;

import java.util.UUID;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.common.api.ApiException;

import org.springframework.http.HttpStatus;

public record CurrentPrincipal(User user, UUID sessionId) {

    public static CurrentPrincipal require() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof CurrentPrincipal principal)) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "A bearer access token is required");
        }
        return principal;
    }

    public void requireRoles(UserRole... allowed) {
        for (UserRole role : allowed) {
            if (user.getRole() == role) {
                return;
            }
        }
        throw new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "You do not have permission for this action");
    }
}
