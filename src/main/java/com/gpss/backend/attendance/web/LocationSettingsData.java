package com.gpss.backend.attendance.web;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.attendance.domain.LocationMode;

public record LocationSettingsData(@JsonProperty("locationMode") LocationMode locationMode) {}
