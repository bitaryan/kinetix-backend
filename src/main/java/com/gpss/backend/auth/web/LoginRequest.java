package com.gpss.backend.auth.web;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.auth.domain.UserRole;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record LoginRequest(
        @JsonProperty("userId") @NotBlank @Size(max = 30) String userId,
        @NotBlank @Size(min = 8, max = 128) String password,
        @NotNull UserRole role) {

    public String normalizedEmployeeId() {
        return userId.strip().toUpperCase();
    }
}
