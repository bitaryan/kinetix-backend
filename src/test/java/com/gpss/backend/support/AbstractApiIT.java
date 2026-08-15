package com.gpss.backend.support;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.gpss.backend.attendance.application.LocationModeCache;
import com.gpss.backend.auth.application.AuthService;
import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.auth.web.CreateUserRequest;
import com.gpss.backend.config.AppProperties;
import com.gpss.backend.security.RateLimiter;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Transactional(propagation = Propagation.NOT_SUPPORTED)
public abstract class AbstractApiIT {

    public static final String ADMIN_PASSWORD = "Admin-secure-pass-12";
    public static final String EMPLOYEE_PASSWORD = "Employee-pass-12";
    public static final String MANAGER_PASSWORD = "Manager-pass-12";

    public static final byte[] TINY_JPEG = new byte[] {
        (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, (byte) 0xFF, (byte) 0xDB, 0x00, 0x43, 0x00, 0x08,
        0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D,
        0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C,
        0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30,
        0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34, 0x32, (byte) 0xFF,
        (byte) 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, (byte) 0xFF, (byte) 0xC4,
        0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, (byte) 0xFF,
        (byte) 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, (byte) 0xAA, (byte) 0xFF, (byte) 0xD9
    };

    static final PostgreSQLContainer<?> POSTGRES;
    static final boolean USE_CONTAINER;

    static {
        PostgreSQLContainer<?> container = null;
        boolean started = false;
        try {
            container = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
                    .withDatabaseName("gpss")
                    .withUsername("gpss")
                    .withPassword("gpss");
            container.start();
            started = true;
        } catch (RuntimeException ex) {
            container = null;
            started = false;
        }
        POSTGRES = container;
        USE_CONTAINER = started;
    }

    @DynamicPropertySource
    static void registerDatasource(DynamicPropertyRegistry registry) {
        if (USE_CONTAINER) {
            registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
            registry.add("spring.datasource.username", POSTGRES::getUsername);
            registry.add("spring.datasource.password", POSTGRES::getPassword);
            registry.add("gpss.database-url", () -> POSTGRES.getJdbcUrl() + "?sslmode=disable");
        } else {
            registry.add("spring.datasource.url", () -> "jdbc:postgresql://localhost:5432/gpss");
            registry.add("spring.datasource.username", () -> "gpss");
            registry.add("spring.datasource.password", () -> "gpss");
            registry.add("gpss.database-url", () -> "jdbc:postgresql://localhost:5432/gpss");
        }
        registry.add("gpss.upload-dir", () -> "uploads/test");
    }

    @Autowired
    protected MockMvc mockMvc;

    @Autowired
    protected ObjectMapper objectMapper;

    @Autowired
    protected JdbcTemplate jdbc;

    @Autowired
    protected AuthService authService;

    @Autowired
    protected AppProperties properties;

    @Autowired
    protected RateLimiter rateLimiter;

    @Autowired
    protected LocationModeCache locationModeCache;

    @BeforeEach
    void resetState() throws Exception {
        locationModeCache.clear();
        rateLimiter.clear();
        properties.setLoginRateLimitPerMinute(1000);
        properties.setRefreshRateLimitPerMinute(1000);
        properties.setLocationPingRateLimitPerMinute(1000);
        properties.setLocationPingMinIntervalSeconds(0);
        properties.setLocationPingMaxPerSession(6000);
        Path upload = Path.of("uploads/test");
        if (Files.exists(upload)) {
            Files.walk(upload)
                    .sorted((a, b) -> b.compareTo(a))
                    .forEach(path -> {
                        try {
                            Files.deleteIfExists(path);
                        } catch (Exception ignored) {
                        }
                    });
        }
        jdbc.execute(
                "TRUNCATE TABLE leaves, client_logs, location_pings, attendance_sessions, "
                        + "location_settings, active_sessions, users RESTART IDENTITY CASCADE");
        jdbc.execute(
                "INSERT INTO location_settings (settings_id, singleton_key, location_mode) "
                        + "VALUES (gen_random_uuid(), 'default', 'continuous')");
    }

    protected User seedAdmin() {
        return authService.createUser(
                new CreateUserRequest("ADM1001", "Admin User", "admin@example.com", ADMIN_PASSWORD, UserRole.ADMIN),
                true);
    }

    protected User seedEmployee() {
        return authService.createUser(
                new CreateUserRequest(
                        "EMP1001", "Employee User", "employee@example.com", EMPLOYEE_PASSWORD, UserRole.EMPLOYEE),
                false);
    }

    protected User seedManager() {
        return authService.createUser(
                new CreateUserRequest(
                        "MGR1001", "Manager User", "manager@example.com", MANAGER_PASSWORD, UserRole.MANAGER),
                false);
    }

    protected MvcResult login(String userId, String password, String role) throws Exception {
        String body = """
                {"userId":"%s","password":"%s","role":"%s"}
                """.formatted(userId, password, role);
        return mockMvc.perform(post("/api/v1/auth/login").contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn();
    }

    protected String accessToken(MvcResult login) throws Exception {
        JsonNode node = objectMapper.readTree(login.getResponse().getContentAsString());
        return node.path("data").path("accessToken").asText();
    }

    protected String bearer(MvcResult login) throws Exception {
        return "Bearer " + accessToken(login);
    }

    protected MvcResult punchIn(String authorization) throws Exception {
        return mockMvc.perform(multipart("/api/v1/attendance/punch-in")
                        .file(new MockMultipartFile("selfie", "selfie.jpg", "image/jpeg", TINY_JPEG))
                        .file(new MockMultipartFile("openingOdoImage", "odo.jpg", "image/jpeg", TINY_JPEG))
                        .param("openingOdoKm", "1234.50")
                        .param("latitude", "28.6139")
                        .param("longitude", "77.2090")
                        .param("accuracy", "12.5")
                        .param("capturedAt", java.time.OffsetDateTime.now().toString())
                        .header("Authorization", authorization))
                .andReturn();
    }

    protected UUID writeUpload(UUID ownerId, String kind) throws Exception {
        UUID sessionId = UUID.randomUUID();
        Path path = Path.of("uploads/test", "attendance", ownerId.toString(), sessionId.toString(), kind + ".jpg");
        Files.createDirectories(path.getParent());
        Files.write(path, TINY_JPEG);
        return sessionId;
    }
}
