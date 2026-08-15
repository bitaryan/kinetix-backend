package com.gpss.backend.upload;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.config.AppProperties;

@Service
public class ImageStorageService {

    private static final Logger log = LoggerFactory.getLogger(ImageStorageService.class);
    private static final Set<String> ATTENDANCE_TYPES =
            Set.of("image/jpeg", "image/jpg", "image/png", "image/webp");
    private static final Set<String> CLIENT_LOG_TYPES = Set.of("image/jpeg", "image/jpg", "image/png");

    private final AppProperties properties;

    public ImageStorageService(AppProperties properties) {
        this.properties = properties;
    }

    public String saveAttendanceImage(MultipartFile upload, UUID userId, UUID sessionId, String kind) {
        byte[] payload = readAttendance(upload, kind);
        String extension = extensionFromMagic(payload);
        if (extension == null) {
            throw new ApiException(
                    HttpStatus.BAD_REQUEST, "INVALID_IMAGE", kind + " must be a valid JPEG, PNG, or WebP image");
        }
        Path relative = Path.of("attendance", userId.toString(), sessionId.toString(), kind + extension);
        write(relative, payload);
        return relative.toString().replace('\\', '/');
    }

    public String saveClientLogSelfie(MultipartFile upload, UUID userId, UUID logId) {
        String contentType = contentType(upload);
        if (!CLIENT_LOG_TYPES.contains(contentType)) {
            throw new ApiException(400, "INVALID_IMAGE", "Image size exceeds 5MB or invalid format");
        }
        byte[] payload;
        try {
            payload = readCapped(upload);
        } catch (ApiException ex) {
            if ("IMAGE_TOO_LARGE".equals(ex.getCode())) {
                throw new ApiException(400, "INVALID_IMAGE", "Image size exceeds 5MB or invalid format");
            }
            throw ex;
        }
        if (payload.length == 0) {
            throw new ApiException(400, "INVALID_IMAGE", "Image size exceeds 5MB or invalid format");
        }
        String extension = extensionFromMagic(payload);
        if (!".jpg".equals(extension) && !".png".equals(extension)) {
            throw new ApiException(400, "INVALID_IMAGE", "Image size exceeds 5MB or invalid format");
        }
        var now = java.time.ZonedDateTime.now(java.time.ZoneOffset.UTC);
        Path relative = Path.of(
                "client_logs",
                String.format("%04d", now.getYear()),
                String.format("%02d", now.getMonthValue()),
                userId.toString(),
                logId + extension);
        write(relative, payload);
        return relative.toString().replace('\\', '/');
    }

    public String selfieUrl(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            return null;
        }
        String path = "/uploads/" + relativePath.replaceFirst("^/+", "");
        String base = properties.getPublicBaseUrl() == null ? "" : properties.getPublicBaseUrl().replaceAll("/+$", "");
        if (base.isBlank()) {
            return path;
        }
        return base + path;
    }

    public void deleteStoredFiles(String... relativePaths) {
        Path root = Path.of(properties.getUploadDir()).toAbsolutePath().normalize();
        for (String relative : relativePaths) {
            if (relative == null || relative.isBlank()) {
                continue;
            }
            Path absolute = Path.of(properties.getUploadDir(), relative).toAbsolutePath().normalize();
            if (!absolute.startsWith(root)) {
                continue;
            }
            try {
                Files.deleteIfExists(absolute);
            } catch (IOException ex) {
                log.warn("Failed to delete orphaned upload {}", absolute, ex);
            }
        }
    }

    private byte[] readAttendance(MultipartFile upload, String kind) {
        String contentType = contentType(upload);
        if (!ATTENDANCE_TYPES.contains(contentType)) {
            throw new ApiException(400, "INVALID_IMAGE", kind + " must be a JPEG, PNG, or WebP image");
        }
        byte[] payload = readCapped(upload);
        if (payload.length == 0) {
            throw new ApiException(400, "INVALID_IMAGE", kind + " file is empty");
        }
        return payload;
    }

    private byte[] readCapped(MultipartFile upload) {
        try {
            if (upload.getSize() > properties.getMaxUploadBytes()) {
                throw new ApiException(400, "IMAGE_TOO_LARGE", "Upload exceeds the maximum upload size");
            }
            byte[] payload = upload.getBytes();
            if (payload.length > properties.getMaxUploadBytes()) {
                throw new ApiException(400, "IMAGE_TOO_LARGE", "Upload exceeds the maximum upload size");
            }
            return payload;
        } catch (IOException ex) {
            throw new ApiException(400, "INVALID_IMAGE", "Image size exceeds 5MB or invalid format");
        }
    }

    private void write(Path relative, byte[] payload) {
        Path absolute = Path.of(properties.getUploadDir()).resolve(relative);
        try {
            Files.createDirectories(absolute.getParent());
            Files.write(absolute, payload);
        } catch (IOException ex) {
            throw new ApiException(500, "INTERNAL_ERROR", "An unexpected error occurred");
        }
    }

    private static String contentType(MultipartFile upload) {
        String type = upload.getContentType();
        return type == null ? "" : type.toLowerCase(Locale.ROOT).strip();
    }

    public static String extensionFromMagic(byte[] payload) {
        if (payload.length >= 3 && payload[0] == (byte) 0xFF && payload[1] == (byte) 0xD8 && payload[2] == (byte) 0xFF) {
            return ".jpg";
        }
        if (payload.length >= 8
                && payload[0] == (byte) 0x89
                && payload[1] == 0x50
                && payload[2] == 0x4E
                && payload[3] == 0x47
                && payload[4] == 0x0D
                && payload[5] == 0x0A
                && payload[6] == 0x1A
                && payload[7] == 0x0A) {
            return ".png";
        }
        if (payload.length >= 12
                && payload[0] == 'R'
                && payload[1] == 'I'
                && payload[2] == 'F'
                && payload[3] == 'F'
                && payload[8] == 'W'
                && payload[9] == 'E'
                && payload[10] == 'B'
                && payload[11] == 'P') {
            return ".webp";
        }
        return null;
    }
}
