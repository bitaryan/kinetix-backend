package com.gpss.backend.attendance.web;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;

public class LocationPingDtos {

    public record LocationPingPoint(
            @DecimalMin("-90") @DecimalMax("90") double latitude,
            @DecimalMin("-180") @DecimalMax("180") double longitude,
            @DecimalMin("0") Double accuracy,
            @JsonProperty("capturedAt") @NotBlank String capturedAt,
            @DecimalMin("0") @DecimalMax("100") Double battery,
            @DecimalMin("0") Double speed,
            @JsonProperty("clientEventId") UUID clientEventId,
            @JsonProperty("isMock") Boolean isMock) {}

    public record LocationPingRequest(
            @JsonProperty("sessionId") @NotNull UUID sessionId,
            @DecimalMin("-90") @DecimalMax("90") double latitude,
            @DecimalMin("-180") @DecimalMax("180") double longitude,
            @DecimalMin("0") Double accuracy,
            @JsonProperty("capturedAt") @NotBlank String capturedAt,
            @DecimalMin("0") @DecimalMax("100") Double battery,
            @DecimalMin("0") Double speed,
            @JsonProperty("clientEventId") UUID clientEventId,
            @JsonProperty("isMock") Boolean isMock) {

        public LocationPingPoint asPoint() {
            return new LocationPingPoint(
                    latitude, longitude, accuracy, capturedAt, battery, speed, clientEventId, isMock);
        }
    }

    public record LocationPingBatchRequest(
            @JsonProperty("sessionId") @NotNull UUID sessionId,
            @NotEmpty @Valid List<LocationPingPoint> pings) {}

    public record LocationSettingsUpdate(@JsonProperty("locationMode") @NotNull com.gpss.backend.attendance.domain.LocationMode locationMode) {}
}
