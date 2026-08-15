package com.gpss.backend.clientlog.application;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.clientlog.domain.ClientLog;
import com.gpss.backend.clientlog.infra.ClientLogRepository;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.upload.ImageStorageService;

@Service
public class ClientLogService {

    private static final Pattern MOBILE = Pattern.compile("^[0-9]{10}$");
    private static final Pattern DMY = Pattern.compile("^(\\d{2})/(\\d{2})/(\\d{4})$");
    private static final DateTimeFormatter OUT = DateTimeFormatter.ofPattern("dd/MM/yyyy", Locale.UK);
    private static final Pattern EMAIL = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");

    private final ClientLogRepository logs;
    private final ImageStorageService images;

    public ClientLogService(ClientLogRepository logs, ImageStorageService images) {
        this.logs = logs;
        this.images = images;
    }

    @Transactional(readOnly = true)
    public Page<ClientLog> list(UUID userId, int page, int limit, String search) {
        PageRequest pageable = PageRequest.of(page - 1, limit);
        if (search == null || search.isBlank()) {
            return logs.findByUserIdOrderByLogDateDescCreatedAtDesc(userId, pageable);
        }
        String escaped = escapeLike(search.strip());
        return logs.searchForUser(userId, escaped, pageable);
    }

    @Transactional
    public ClientLog create(
            UUID userId,
            String clientName,
            String companyName,
            String mobileNumber,
            String mailId,
            LocalDate logDate,
            Double latitude,
            Double longitude,
            Double accuracy,
            MultipartFile selfie) {
        if ((latitude == null) != (longitude == null)) {
            throw new ApiException(422, "VALIDATION_ERROR", "latitude and longitude must be provided together");
        }
        UUID logId = UUID.randomUUID();
        String selfiePath = null;
        try {
            if (selfie != null && selfie.getOriginalFilename() != null && !selfie.getOriginalFilename().isBlank()) {
                selfiePath = images.saveClientLogSelfie(selfie, userId, logId);
            }
            ClientLog log = new ClientLog();
            log.setId(logId);
            log.setUserId(userId);
            log.setClientName(clientName);
            log.setCompanyName(companyName);
            log.setMobileNumber(mobileNumber);
            log.setMailId(mailId);
            log.setLogDate(logDate);
            log.setSelfiePath(selfiePath);
            log.setLatitude(toCoord(latitude));
            log.setLongitude(toCoord(longitude));
            log.setLocationAccuracy(accuracy);
            return logs.save(log);
        } catch (RuntimeException ex) {
            if (selfiePath != null) {
                images.deleteStoredFiles(selfiePath);
            }
            throw ex;
        }
    }

    @Transactional
    public void delete(UUID logId, User actor) {
        ClientLog log = logs.findById(logId).orElse(null);
        if (log == null || (actor.getRole() != UserRole.ADMIN && !log.getUserId().equals(actor.getId()))) {
            throw new ApiException(404, "NOT_FOUND", "Client log not found");
        }
        String selfiePath = log.getSelfiePath();
        logs.delete(log);
        if (selfiePath != null) {
            images.deleteStoredFiles(selfiePath);
        }
    }

    public String selfieUrl(ClientLog log) {
        return images.selfieUrl(log.getSelfiePath());
    }

    public static String formatDate(LocalDate value) {
        return value.format(OUT);
    }

    public static LocalDate parseDate(String value) {
        String raw = value.strip();
        Matcher match = DMY.matcher(raw);
        if (match.matches()) {
            try {
                return LocalDate.of(
                        Integer.parseInt(match.group(3)),
                        Integer.parseInt(match.group(2)),
                        Integer.parseInt(match.group(1)));
            } catch (DateTimeException ex) {
                throw new ApiException(422, "VALIDATION_ERROR", "Select a valid date");
            }
        }
        try {
            return LocalDate.parse(raw);
        } catch (Exception ex) {
            throw new ApiException(422, "VALIDATION_ERROR", "Select a valid date");
        }
    }

    public static String validateMobile(String value) {
        String cleaned = value.strip();
        if (!MOBILE.matcher(cleaned).matches()) {
            throw new ApiException(422, "VALIDATION_ERROR", "Please enter a valid 10-digit mobile number");
        }
        return cleaned;
    }

    public static String validateEmail(String value) {
        String cleaned = value.strip().toLowerCase(Locale.ROOT);
        if (!EMAIL.matcher(cleaned).matches()) {
            throw new ApiException(422, "VALIDATION_ERROR", "Please enter a valid email address");
        }
        return cleaned;
    }

    public static String requireName(String value, String emptyMessage) {
        if (value == null) {
            throw new ApiException(422, "VALIDATION_ERROR", emptyMessage);
        }
        String cleaned = value.strip();
        if (cleaned.length() < 2) {
            throw new ApiException(422, "VALIDATION_ERROR", emptyMessage);
        }
        return cleaned;
    }

    public static String escapeLike(String value) {
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    private static BigDecimal toCoord(Double value) {
        if (value == null) {
            return null;
        }
        return BigDecimal.valueOf(value).setScale(8, RoundingMode.HALF_UP);
    }
}
