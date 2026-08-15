package com.gpss.backend.auth.web;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.auth.domain.UserRole;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateUserRequest(
        @JsonProperty("userId") @NotBlank @Size(max = 30) String userId,
        @JsonProperty("employeeName") @NotBlank @Size(max = 100) String employeeName,
        @Email @NotBlank String email,
        @NotBlank @Size(min = 12, max = 128) String password,
        UserRole role) {

    public UserRole resolvedRole() {
        return role == null ? UserRole.EMPLOYEE : role;
    }

    public String normalizedEmployeeId() {
        return userId.strip().toUpperCase();
    }

    public String normalizedEmail() {
        return email.strip().toLowerCase();
    }

    public String normalizedName() {
        return employeeName.strip();
    }

    public boolean passwordComplexEnough() {
        boolean lower = false;
        boolean upper = false;
        boolean digit = false;
        for (int i = 0; i < password.length(); i++) {
            char c = password.charAt(i);
            if (Character.isLowerCase(c)) {
                lower = true;
            } else if (Character.isUpperCase(c)) {
                upper = true;
            } else if (Character.isDigit(c)) {
                digit = true;
            }
        }
        return lower && upper && digit;
    }
}
