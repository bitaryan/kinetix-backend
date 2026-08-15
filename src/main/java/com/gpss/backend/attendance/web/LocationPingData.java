package com.gpss.backend.attendance.web;

import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.attendance.domain.LocationMode;

public record LocationPingData(
        boolean accepted,
        String reason,
        @JsonProperty("pingId") UUID pingId,
        @JsonProperty("locationMode") LocationMode locationMode) {}
