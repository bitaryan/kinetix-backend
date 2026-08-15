package com.gpss.backend.attendance.web;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.attendance.domain.AttendanceStatus;

public record PunchOutData(
        @JsonProperty("sessionId") UUID sessionId,
        AttendanceStatus status,
        @JsonProperty("punchedInAt") Instant punchedInAt,
        @JsonProperty("punchedOutAt") Instant punchedOutAt) {}
