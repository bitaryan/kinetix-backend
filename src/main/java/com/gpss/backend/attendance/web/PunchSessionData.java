package com.gpss.backend.attendance.web;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.attendance.domain.AttendanceStatus;
import com.gpss.backend.attendance.domain.LocationMode;

public record PunchSessionData(
        @JsonProperty("sessionId") UUID sessionId,
        AttendanceStatus status,
        @JsonProperty("punchedInAt") Instant punchedInAt,
        @JsonProperty("punchedOutAt") Instant punchedOutAt,
        @JsonProperty("openingOdoKm") @JsonFormat(shape = JsonFormat.Shape.STRING) BigDecimal openingOdoKm,
        @JsonProperty("closingOdoKm") @JsonFormat(shape = JsonFormat.Shape.STRING) BigDecimal closingOdoKm,
        double latitude,
        double longitude,
        @JsonProperty("locationMode") LocationMode locationMode) {}
