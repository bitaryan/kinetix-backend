package com.gpss.backend.attendance.api;

import java.math.BigDecimal;
import java.math.RoundingMode;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import com.gpss.backend.attendance.application.AttendanceService;
import com.gpss.backend.attendance.application.AttendanceService.PunchInResult;
import com.gpss.backend.attendance.domain.AttendanceSession;
import com.gpss.backend.attendance.domain.AttendanceStatus;
import com.gpss.backend.attendance.domain.LocationMode;
import com.gpss.backend.attendance.web.CurrentSessionData;
import com.gpss.backend.attendance.web.LocationPingBatchData;
import com.gpss.backend.attendance.web.LocationPingData;
import com.gpss.backend.attendance.web.LocationPingDtos.LocationPingBatchRequest;
import com.gpss.backend.attendance.web.LocationPingDtos.LocationPingRequest;
import com.gpss.backend.attendance.web.LocationPingDtos.LocationSettingsUpdate;
import com.gpss.backend.attendance.web.LocationSettingsData;
import com.gpss.backend.attendance.web.PunchOutData;
import com.gpss.backend.attendance.web.PunchSessionData;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.common.api.ApiResponse;
import com.gpss.backend.security.CurrentPrincipal;
import com.gpss.backend.security.RateLimiter;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;

@RestController
@Validated
public class AttendanceController {

    private final AttendanceService attendanceService;
    private final RateLimiter rateLimiter;

    public AttendanceController(AttendanceService attendanceService, RateLimiter rateLimiter) {
        this.attendanceService = attendanceService;
        this.rateLimiter = rateLimiter;
    }

    @PostMapping(path = "/api/v1/attendance/punch-in", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<ApiResponse<PunchSessionData>> punchIn(
            @RequestPart("selfie") MultipartFile selfie,
            @RequestPart("openingOdoImage") MultipartFile openingOdoImage,
            @RequestParam("openingOdoKm") BigDecimal openingOdoKm,
            @RequestParam("latitude") double latitude,
            @RequestParam("longitude") double longitude,
            @RequestParam(value = "accuracy", required = false) String accuracy,
            @RequestParam(value = "capturedAt", required = false) String capturedAt) {
        CurrentPrincipal principal = fieldStaff();
        validateOdo(openingOdoKm);
        validateCoords(latitude, longitude);
        PunchInResult result = attendanceService.punchIn(
                principal.user().getId(),
                openingOdoKm,
                latitude,
                longitude,
                parseOptionalFloat(accuracy),
                capturedAt,
                selfie,
                openingOdoImage);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.ok(toSession(result.session(), result.locationMode())));
    }

    @GetMapping("/api/v1/attendance/current")
    public ApiResponse<CurrentSessionData> current() {
        CurrentPrincipal principal = fieldStaff();
        LocationMode mode = attendanceService.resolveLocationMode();
        AttendanceSession session = attendanceService.current(principal.user().getId());
        if (session == null) {
            return ApiResponse.ok(new CurrentSessionData(false, null, mode));
        }
        return ApiResponse.ok(new CurrentSessionData(true, toSession(session, mode), mode));
    }

    @PostMapping("/api/v1/attendance/location-ping")
    public ApiResponse<LocationPingData> locationPing(
            @Valid @RequestBody LocationPingRequest payload, HttpServletRequest request) {
        CurrentPrincipal principal = fieldStaff();
        rateLimiter.enforceLocationPing(request, principal.user().getId(), 1);
        return ApiResponse.ok(attendanceService.locationPing(principal.user().getId(), payload));
    }

    @PostMapping("/api/v1/attendance/location-pings")
    public ApiResponse<LocationPingBatchData> locationPings(
            @Valid @RequestBody LocationPingBatchRequest payload, HttpServletRequest request) {
        CurrentPrincipal principal = fieldStaff();
        rateLimiter.enforceLocationPing(request, principal.user().getId(), payload.pings().size());
        return ApiResponse.ok(attendanceService.locationPingBatch(principal.user().getId(), payload));
    }

    @PostMapping(path = "/api/v1/attendance/punch-out", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<PunchOutData> punchOut(
            @RequestPart("closingOdoImage") MultipartFile closingOdoImage,
            @RequestParam("closingOdoKm") BigDecimal closingOdoKm,
            @RequestParam("latitude") double latitude,
            @RequestParam("longitude") double longitude,
            @RequestParam(value = "accuracy", required = false) String accuracy,
            @RequestParam(value = "capturedAt", required = false) String capturedAt) {
        CurrentPrincipal principal = fieldStaff();
        validateOdo(closingOdoKm);
        validateCoords(latitude, longitude);
        AttendanceSession session = attendanceService.punchOut(
                principal.user().getId(),
                closingOdoKm,
                latitude,
                longitude,
                parseOptionalFloat(accuracy),
                capturedAt,
                closingOdoImage);
        if (session.getPunchedOutAt() == null) {
            throw new ApiException(500, "INTERNAL_ERROR", "Punch-out completed without a timestamp");
        }
        return ApiResponse.ok(new PunchOutData(
                session.getId(), AttendanceStatus.punched_out, session.getPunchedInAt(), session.getPunchedOutAt()));
    }

    @GetMapping("/api/v1/admin/location-settings")
    public ApiResponse<LocationSettingsData> getLocationSettings() {
        CurrentPrincipal.require().requireRoles(UserRole.ADMIN);
        return ApiResponse.ok(new LocationSettingsData(attendanceService.resolveLocationMode()));
    }

    @PatchMapping("/api/v1/admin/location-settings")
    public ApiResponse<LocationSettingsData> updateLocationSettings(
            @Valid @RequestBody LocationSettingsUpdate payload) {
        CurrentPrincipal.require().requireRoles(UserRole.ADMIN);
        return ApiResponse.ok(new LocationSettingsData(attendanceService.updateLocationMode(payload.locationMode())));
    }

    private static CurrentPrincipal fieldStaff() {
        CurrentPrincipal principal = CurrentPrincipal.require();
        principal.requireRoles(UserRole.EMPLOYEE, UserRole.MANAGER);
        return principal;
    }

    private static PunchSessionData toSession(AttendanceSession session, LocationMode mode) {
        return new PunchSessionData(
                session.getId(),
                session.getStatus(),
                session.getPunchedInAt(),
                session.getPunchedOutAt(),
                session.getOpeningOdoKm().setScale(2, RoundingMode.HALF_UP),
                session.getClosingOdoKm() == null
                        ? null
                        : session.getClosingOdoKm().setScale(2, RoundingMode.HALF_UP),
                session.getPunchInLatitude(),
                session.getPunchInLongitude(),
                mode);
    }

    private static void validateOdo(BigDecimal odo) {
        if (odo == null
                || odo.compareTo(BigDecimal.ZERO) < 0
                || odo.compareTo(new BigDecimal("9999999.99")) > 0) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
    }

    private static void validateCoords(double latitude, double longitude) {
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
    }

    private static Double parseOptionalFloat(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            double parsed = Double.parseDouble(value);
            if (parsed < 0) {
                throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
            }
            return parsed;
        } catch (NumberFormatException ex) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
    }
}
