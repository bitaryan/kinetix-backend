package com.gpss.backend.auth.web;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.domain.UserRole;

public record UserProfileDto(
        UUID id,
        @JsonProperty("userId") String userId,
        @JsonProperty("employeeName") String employeeName,
        String email,
        UserRole role,
        @JsonProperty("isActive") boolean isActive,
        @JsonProperty("createdAt") Instant createdAt) {

    public static UserProfileDto from(User user) {
        return new UserProfileDto(
                user.getId(),
                user.getEmployeeId(),
                user.getEmployeeName(),
                user.getEmail(),
                user.getRole(),
                user.isActive(),
                user.getCreatedAt());
    }
}
