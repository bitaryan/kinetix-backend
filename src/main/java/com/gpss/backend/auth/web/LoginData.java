package com.gpss.backend.auth.web;

import com.fasterxml.jackson.annotation.JsonProperty;

public record LoginData(
        @JsonProperty("accessToken") String accessToken,
        @JsonProperty("tokenType") String tokenType,
        @JsonProperty("expiresIn") int expiresIn,
        UserProfileDto user) {}
