package com.gpss.backend.attendance.web;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.attendance.domain.LocationMode;

public record LocationPingBatchData(
        @JsonProperty("acceptedCount") int acceptedCount,
        @JsonProperty("rejectedCount") int rejectedCount,
        @JsonProperty("locationMode") LocationMode locationMode,
        List<LocationPingBatchItemData> items) {

    public record LocationPingBatchItemData(
            int index, boolean accepted, String reason, @JsonProperty("pingId") UUID pingId) {}
}
