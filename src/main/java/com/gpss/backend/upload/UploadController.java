package com.gpss.backend.upload;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;

import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import jakarta.servlet.http.HttpServletRequest;

import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.config.AppProperties;
import com.gpss.backend.security.CurrentPrincipal;

@RestController
public class UploadController {

    private static final Map<String, MediaType> MEDIA = Map.of(
            ".jpg", MediaType.IMAGE_JPEG,
            ".jpeg", MediaType.IMAGE_JPEG,
            ".png", MediaType.IMAGE_PNG,
            ".webp", MediaType.parseMediaType("image/webp"));

    private final AppProperties properties;

    public UploadController(AppProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/uploads/**")
    public ResponseEntity<Resource> serve(HttpServletRequest request) throws IOException {
        CurrentPrincipal principal = CurrentPrincipal.require();
        Path root = Path.of(properties.getUploadDir()).toAbsolutePath().normalize();
        String uri = request.getRequestURI();
        String prefix = "/uploads/";
        int idx = uri.indexOf(prefix);
        String relative = idx < 0 ? "" : uri.substring(idx + prefix.length());
        Path candidate = Path.of(properties.getUploadDir(), relative).toAbsolutePath().normalize();
        if (!candidate.startsWith(root) || !Files.isRegularFile(candidate)) {
            throw new ApiException(404, "NOT_FOUND", "File not found");
        }
        if (principal.user().getRole() == UserRole.EMPLOYEE) {
            UUID owner = ownerUserId(root.relativize(candidate));
            if (owner == null || !owner.equals(principal.user().getId())) {
                throw new ApiException(404, "NOT_FOUND", "File not found");
            }
        }
        String suffix = suffix(candidate.getFileName().toString());
        MediaType mediaType = MEDIA.getOrDefault(suffix, MediaType.APPLICATION_OCTET_STREAM);
        return ResponseEntity.ok().contentType(mediaType).body(new FileSystemResource(candidate));
    }

    private static UUID ownerUserId(Path relative) {
        if (relative.getNameCount() >= 2 && "attendance".equals(relative.getName(0).toString())) {
            try {
                return UUID.fromString(relative.getName(1).toString());
            } catch (IllegalArgumentException ex) {
                return null;
            }
        }
        if (relative.getNameCount() >= 4 && "client_logs".equals(relative.getName(0).toString())) {
            try {
                return UUID.fromString(relative.getName(3).toString());
            } catch (IllegalArgumentException ex) {
                return null;
            }
        }
        return null;
    }

    private static String suffix(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot).toLowerCase();
    }
}
