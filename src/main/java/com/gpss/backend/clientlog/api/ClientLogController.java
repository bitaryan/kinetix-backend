package com.gpss.backend.clientlog.api;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.clientlog.application.ClientLogService;
import com.gpss.backend.clientlog.domain.ClientLog;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.common.api.ApiListResponse;
import com.gpss.backend.common.api.ApiResponse;
import com.gpss.backend.security.CurrentPrincipal;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/v1/client-logs")
public class ClientLogController {

    private final ClientLogService service;

    public ClientLogController(ClientLogService service) {
        this.service = service;
    }

    @GetMapping
    public ApiListResponse<List<ClientLogItem>> list(
            @RequestParam(defaultValue = "1") @Min(1) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit,
            @RequestParam(required = false) @Size(max = 80) String search) {
        CurrentPrincipal principal = fieldStaff();
        if (search != null && search.length() > 80) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
        Page<ClientLog> result = service.list(principal.user().getId(), page, limit, search);
        List<ClientLogItem> items =
                result.getContent().stream().map(log -> ClientLogItem.from(log, service.selfieUrl(log))).toList();
        int totalPages = result.getTotalElements() == 0 ? 0 : result.getTotalPages();
        return ApiListResponse.ok(
                items, new ClientLogMeta(page, limit, result.getTotalElements(), totalPages));
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<ApiResponse<ClientLogCreated>> create(
            @RequestParam("client_name") String clientName,
            @RequestParam("company_name") String companyName,
            @RequestParam("mobile_number") String mobileNumber,
            @RequestParam("mail_id") String mailId,
            @RequestParam("date") String date,
            @RequestParam(value = "latitude", required = false) String latitude,
            @RequestParam(value = "longitude", required = false) String longitude,
            @RequestParam(value = "accuracy", required = false) String accuracy,
            @RequestPart(value = "selfie", required = false) MultipartFile selfie) {
        CurrentPrincipal principal = fieldStaff();
        LocalDate logDate = ClientLogService.parseDate(date);
        ClientLog log = service.create(
                principal.user().getId(),
                ClientLogService.requireName(clientName, "Please enter client name"),
                ClientLogService.requireName(companyName, "Please enter company name"),
                ClientLogService.validateMobile(mobileNumber),
                ClientLogService.validateEmail(mailId),
                logDate,
                parseOptionalFloat(latitude),
                parseOptionalFloat(longitude),
                parseOptionalFloat(accuracy),
                selfie);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.ok(ClientLogCreated.from(log, service.selfieUrl(log))));
    }

    @DeleteMapping("/{logId}")
    public ApiResponse<DeleteMessage> delete(@PathVariable UUID logId) {
        CurrentPrincipal principal = CurrentPrincipal.require();
        principal.requireRoles(UserRole.MANAGER, UserRole.ADMIN);
        service.delete(logId, principal.user());
        return ApiResponse.ok(new DeleteMessage("Client log deleted successfully"));
    }

    private static CurrentPrincipal fieldStaff() {
        CurrentPrincipal principal = CurrentPrincipal.require();
        principal.requireRoles(UserRole.EMPLOYEE, UserRole.MANAGER);
        return principal;
    }

    private static Double parseOptionalFloat(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Double.parseDouble(value);
        } catch (NumberFormatException ex) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
    }

    public record ClientLogMeta(int page, int limit, @JsonProperty("totalCount") long totalCount, @JsonProperty("totalPages") int totalPages) {}

    public record DeleteMessage(String message) {}

    public record ClientLogItem(
            UUID id,
            @JsonProperty("userId") UUID userId,
            @JsonProperty("clientName") String clientName,
            @JsonProperty("companyName") String companyName,
            @JsonProperty("mobileNumber") String mobileNumber,
            @JsonProperty("mailId") String mailId,
            String date,
            @JsonProperty("selfieUrl") String selfieUrl,
            Double latitude,
            Double longitude,
            @JsonProperty("locationAccuracy") Double locationAccuracy,
            @JsonProperty("createdAt") Instant createdAt) {
        static ClientLogItem from(ClientLog log, String selfieUrl) {
            return new ClientLogItem(
                    log.getId(),
                    log.getUserId(),
                    log.getClientName(),
                    log.getCompanyName(),
                    log.getMobileNumber(),
                    log.getMailId(),
                    ClientLogService.formatDate(log.getLogDate()),
                    selfieUrl,
                    log.getLatitude() == null ? null : log.getLatitude().doubleValue(),
                    log.getLongitude() == null ? null : log.getLongitude().doubleValue(),
                    log.getLocationAccuracy(),
                    log.getCreatedAt());
        }
    }

    public record ClientLogCreated(
            UUID id,
            @JsonProperty("clientName") String clientName,
            @JsonProperty("companyName") String companyName,
            @JsonProperty("mobileNumber") String mobileNumber,
            @JsonProperty("mailId") String mailId,
            String date,
            @JsonProperty("selfieUrl") String selfieUrl,
            Double latitude,
            Double longitude,
            @JsonProperty("createdAt") Instant createdAt) {
        static ClientLogCreated from(ClientLog log, String selfieUrl) {
            return new ClientLogCreated(
                    log.getId(),
                    log.getClientName(),
                    log.getCompanyName(),
                    log.getMobileNumber(),
                    log.getMailId(),
                    ClientLogService.formatDate(log.getLogDate()),
                    selfieUrl,
                    log.getLatitude() == null ? null : log.getLatitude().doubleValue(),
                    log.getLongitude() == null ? null : log.getLongitude().doubleValue(),
                    log.getCreatedAt());
        }
    }
}
