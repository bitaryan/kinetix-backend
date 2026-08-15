package com.gpss.backend.leave.api;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.common.api.ApiListResponse;
import com.gpss.backend.common.api.ApiResponse;
import com.gpss.backend.leave.application.LeaveService;
import com.gpss.backend.leave.domain.Leave;
import com.gpss.backend.leave.domain.LeaveStatus;
import com.gpss.backend.leave.web.LeaveDates;
import com.gpss.backend.security.CurrentPrincipal;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/v1/leaves")
public class LeaveController {

    private final LeaveService leaveService;

    public LeaveController(LeaveService leaveService) {
        this.leaveService = leaveService;
    }

    @GetMapping
    public ApiListResponse<List<LeaveListItem>> list(
            @RequestParam(defaultValue = "1") @Min(1) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit,
            @RequestParam(required = false) LeaveStatus status) {
        User principal = staff().user();
        if (status == LeaveStatus.CANCELLED) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
        Page<Leave> result = leaveService.list(principal, page, limit, status);
        List<LeaveListItem> items = result.getContent().stream().map(LeaveListItem::from).toList();
        return ApiListResponse.ok(items, new LeaveMeta(result.getTotalElements(), page, limit));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<LeaveCreated>> apply(@RequestBody ApplyLeaveRaw payload) {
        User principal = staff().user();
        if (payload.start_date() == null
                || payload.start_date().isBlank()
                || payload.end_date() == null
                || payload.end_date().isBlank()
                || (payload.reason() != null && payload.reason().length() > 500)) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
        LocalDate start = LeaveDates.parse(payload.start_date());
        LocalDate end = LeaveDates.parse(payload.end_date());
        if (end.isBefore(start)) {
            throw new ApiException(422, "INVALID_DATE_RANGE", "End date cannot be earlier than start date.");
        }
        String reason = payload.reason() == null ? "" : payload.reason().strip();
        Leave leave = leaveService.apply(principal, start, end, reason);
        return ResponseEntity.status(HttpStatus.CREATED).body(ApiResponse.ok(LeaveCreated.from(leave)));
    }

    @GetMapping("/{leaveId}")
    public ApiResponse<LeaveDetail> get(@PathVariable UUID leaveId) {
        return ApiResponse.ok(LeaveDetail.from(leaveService.get(leaveId, staff().user())));
    }

    @PatchMapping("/{leaveId}/status")
    public ApiResponse<LeaveStatusUpdated> updateStatus(
            @PathVariable UUID leaveId, @RequestBody UpdateLeaveStatusRaw payload) {
        CurrentPrincipal principal = CurrentPrincipal.require();
        principal.requireRoles(UserRole.MANAGER, UserRole.ADMIN);
        if (payload.status() != LeaveStatus.APPROVED && payload.status() != LeaveStatus.REJECTED) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
        String rejection = payload.rejection_reason() == null ? null : payload.rejection_reason().strip();
        if (rejection != null && rejection.isEmpty()) {
            rejection = null;
        }
        if (payload.status() == LeaveStatus.REJECTED && rejection == null) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
        if (payload.status() == LeaveStatus.APPROVED && rejection != null) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
        Leave leave = leaveService.updateStatus(leaveId, principal.user(), payload.status(), rejection);
        return ApiResponse.ok(new LeaveStatusUpdated(
                leave.getId(),
                LeaveDates.titleCase(leave.getStatus()),
                leave.getUpdatedAt(),
                "Leave application status updated to " + leave.getStatus().name()));
    }

    private static CurrentPrincipal staff() {
        CurrentPrincipal principal = CurrentPrincipal.require();
        principal.requireRoles(UserRole.EMPLOYEE, UserRole.MANAGER, UserRole.ADMIN);
        return principal;
    }

    public record ApplyLeaveRaw(String start_date, String end_date, @Size(max = 500) String reason) {}

    public record UpdateLeaveStatusRaw(LeaveStatus status, String rejection_reason) {}

    public record LeaveMeta(long total, int page, int limit) {}

    public record LeaveListItem(
            UUID id,
            String start_date,
            String end_date,
            String reason,
            String status,
            Instant created_at) {
        static LeaveListItem from(Leave leave) {
            return new LeaveListItem(
                    leave.getId(),
                    LeaveDates.format(leave.getStartDate()),
                    LeaveDates.format(leave.getEndDate()),
                    leave.getReason(),
                    LeaveDates.titleCase(leave.getStatus()),
                    leave.getCreatedAt());
        }
    }

    public record LeaveCreated(
            UUID id,
            UUID user_id,
            String start_date,
            String end_date,
            String reason,
            String status,
            Instant created_at,
            String message) {
        static LeaveCreated from(Leave leave) {
            return new LeaveCreated(
                    leave.getId(),
                    leave.getUserId(),
                    LeaveDates.format(leave.getStartDate()),
                    LeaveDates.format(leave.getEndDate()),
                    leave.getReason(),
                    LeaveDates.titleCase(leave.getStatus()),
                    leave.getCreatedAt(),
                    "Leave application submitted successfully");
        }
    }

    public record LeaveDetail(
            UUID id,
            UUID user_id,
            String applicant_name,
            String start_date,
            String end_date,
            String reason,
            String status,
            String rejection_reason,
            UUID approved_by,
            Instant created_at,
            Instant updated_at) {
        static LeaveDetail from(Leave leave) {
            String name = leave.getUser() == null ? "" : leave.getUser().getEmployeeName();
            return new LeaveDetail(
                    leave.getId(),
                    leave.getUserId(),
                    name,
                    LeaveDates.format(leave.getStartDate()),
                    LeaveDates.format(leave.getEndDate()),
                    leave.getReason(),
                    LeaveDates.titleCase(leave.getStatus()),
                    leave.getRejectionReason(),
                    leave.getApprovedBy(),
                    leave.getCreatedAt(),
                    leave.getUpdatedAt());
        }
    }

    public record LeaveStatusUpdated(UUID id, String status, Instant updated_at, String message) {}
}
