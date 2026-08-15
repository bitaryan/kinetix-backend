package com.gpss.backend.auth.web;

import com.fasterxml.jackson.annotation.JsonProperty;

public record AccessTokenData(
        @JsonProperty("accessToken") String accessToken,
        @JsonProperty("tokenType") String tokenType,
        @JsonProperty("expiresIn") int expiresIn) {}
