package com.gpss.backend.common.api;

import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import com.gpss.backend.auth.infra.UserRepository;

@RestController
public class HealthController {

    private static final Logger log = LoggerFactory.getLogger(HealthController.class);
    private final UserRepository users;

    public HealthController(UserRepository users) {
        this.users = users;
    }

    @GetMapping("/health")
    public ResponseEntity<ApiResponse<Map<String, String>>> health() {
        try {
            users.count();
            return ResponseEntity.ok(ApiResponse.ok(Map.of("status", "ok")));
        } catch (Exception ex) {
            log.error("Health check database ping failed", ex);
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(new ApiResponse<>(
                            false,
                            null,
                            new ApiError("SERVICE_UNAVAILABLE", "Database is unavailable")));
        }
    }
}
