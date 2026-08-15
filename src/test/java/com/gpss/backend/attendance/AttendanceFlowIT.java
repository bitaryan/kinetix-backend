package com.gpss.backend.attendance;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;

import com.gpss.backend.support.AbstractApiIT;

class AttendanceFlowIT extends AbstractApiIT {

    @Test
    void punchInRequiresAuthAndAdminForbidden() throws Exception {
        mockMvc.perform(multipart("/api/v1/attendance/punch-in")
                        .file(new MockMultipartFile("selfie", "s.jpg", "image/jpeg", TINY_JPEG))
                        .file(new MockMultipartFile("openingOdoImage", "o.jpg", "image/jpeg", TINY_JPEG))
                        .param("openingOdoKm", "1")
                        .param("latitude", "1")
                        .param("longitude", "1"))
                .andExpect(status().isUnauthorized());
        seedAdmin();
        String admin = bearer(login("ADM1001", ADMIN_PASSWORD, "ADMIN"));
        mockMvc.perform(multipart("/api/v1/attendance/punch-in")
                        .file(new MockMultipartFile("selfie", "s.jpg", "image/jpeg", TINY_JPEG))
                        .file(new MockMultipartFile("openingOdoImage", "o.jpg", "image/jpeg", TINY_JPEG))
                        .param("openingOdoKm", "1")
                        .param("latitude", "1")
                        .param("longitude", "1")
                        .header("Authorization", admin))
                .andExpect(status().isForbidden());
    }

    @Test
    void punchInCurrentDuplicateAndSoftFails() throws Exception {
        seedEmployee();
        String auth = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        var punched = punchIn(auth);
        assertThat(punched.getResponse().getStatus()).isEqualTo(201);
        var body = objectMapper.readTree(punched.getResponse().getContentAsString());
        assertThat(body.path("data").path("status").asText()).isEqualTo("punched_in");
        assertThat(body.path("data").path("openingOdoKm").asText()).isEqualTo("1234.50");
        String sessionId = body.path("data").path("sessionId").asText();

        mockMvc.perform(get("/api/v1/attendance/current").header("Authorization", auth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.punchedIn").value(true))
                .andExpect(jsonPath("$.data.session.sessionId").value(sessionId));

        assertThat(punchIn(auth).getResponse().getStatus()).isEqualTo(409);

        mockMvc.perform(post("/api/v1/attendance/location-ping")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"sessionId":"%s","latitude":28.616,"longitude":77.211,
                                 "capturedAt":"%s"}
                                """
                                        .formatted(sessionId, OffsetDateTime.now(ZoneOffset.UTC))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.accepted").value(true));

        mockMvc.perform(post("/api/v1/attendance/location-ping")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"sessionId":"%s","latitude":28.616,"longitude":77.211,
                                 "capturedAt":"2026-08-09T10:15:00"}
                                """
                                        .formatted(sessionId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.accepted").value(false))
                .andExpect(jsonPath("$.data.reason").value("INVALID_TIMESTAMP"));
    }

    @Test
    void punchOutThenPingNotActive() throws Exception {
        seedEmployee();
        String auth = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        String sessionId = objectMapper
                .readTree(punchIn(auth).getResponse().getContentAsString())
                .path("data")
                .path("sessionId")
                .asText();
        mockMvc.perform(multipart("/api/v1/attendance/punch-out")
                        .file(new MockMultipartFile("closingOdoImage", "c.jpg", "image/jpeg", TINY_JPEG))
                        .param("closingOdoKm", "1250.00")
                        .param("latitude", "28.6150")
                        .param("longitude", "77.2100")
                        .header("Authorization", auth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("punched_out"));
        mockMvc.perform(post("/api/v1/attendance/location-ping")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"sessionId":"%s","latitude":28.616,"longitude":77.211,
                                 "capturedAt":"%s"}
                                """
                                        .formatted(sessionId, OffsetDateTime.now(ZoneOffset.UTC))))
                .andExpect(jsonPath("$.data.reason").value("SESSION_NOT_ACTIVE"));
        mockMvc.perform(get("/api/v1/attendance/current").header("Authorization", auth))
                .andExpect(jsonPath("$.data.punchedIn").value(false));
    }

    @Test
    void trailFullTooFrequentBatchSingleMode() throws Exception {
        seedEmployee();
        seedAdmin();
        String auth = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        properties.setLocationPingMaxPerSession(2);
        String sessionId = objectMapper
                .readTree(punchIn(auth).getResponse().getContentAsString())
                .path("data")
                .path("sessionId")
                .asText();
        mockMvc.perform(post("/api/v1/attendance/location-ping")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"sessionId":"%s","latitude":28.616,"longitude":77.211,
                                 "capturedAt":"%s"}
                                """
                                        .formatted(sessionId, OffsetDateTime.now(ZoneOffset.UTC).plusSeconds(10))))
                .andExpect(jsonPath("$.data.accepted").value(true));
        mockMvc.perform(post("/api/v1/attendance/location-ping")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"sessionId":"%s","latitude":28.617,"longitude":77.212,
                                 "capturedAt":"%s"}
                                """
                                        .formatted(sessionId, OffsetDateTime.now(ZoneOffset.UTC).plusSeconds(20))))
                .andExpect(jsonPath("$.data.reason").value("SESSION_TRAIL_FULL"));
        properties.setLocationPingMaxPerSession(6000);
    }

    @Test
    void adminSingleMode() throws Exception {
        seedAdmin();
        seedEmployee();
        String admin = bearer(login("ADM1001", ADMIN_PASSWORD, "ADMIN"));
        String emp = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        mockMvc.perform(patch("/api/v1/admin/location-settings")
                        .header("Authorization", admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"locationMode\":\"single\"}"))
                .andExpect(jsonPath("$.data.locationMode").value("single"));
        var punched = punchIn(emp);
        String sessionId = objectMapper.readTree(punched.getResponse().getContentAsString())
                .path("data")
                .path("sessionId")
                .asText();
        mockMvc.perform(post("/api/v1/attendance/location-ping")
                        .header("Authorization", emp)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"sessionId":"%s","latitude":28.616,"longitude":77.211,
                                 "capturedAt":"%s"}
                                """
                                        .formatted(sessionId, OffsetDateTime.now(ZoneOffset.UTC))))
                .andExpect(jsonPath("$.data.reason").value("SINGLE_LOCATION_MODE"));
        mockMvc.perform(patch("/api/v1/admin/location-settings")
                        .header("Authorization", emp)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"locationMode\":\"continuous\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void duplicateClientEventId() throws Exception {
        seedEmployee();
        String auth = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        String sessionId = objectMapper
                .readTree(punchIn(auth).getResponse().getContentAsString())
                .path("data")
                .path("sessionId")
                .asText();
        UUID event = UUID.randomUUID();
        String payload =
                """
                {"sessionId":"%s","latitude":28.616,"longitude":77.211,"capturedAt":"%s","clientEventId":"%s"}
                """
                        .formatted(sessionId, OffsetDateTime.now(ZoneOffset.UTC).plusSeconds(15), event);
        mockMvc.perform(post("/api/v1/attendance/location-ping")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(jsonPath("$.data.accepted").value(true));
        mockMvc.perform(post("/api/v1/attendance/location-ping")
                        .header("Authorization", auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(jsonPath("$.data.accepted").value(true))
                .andExpect(jsonPath("$.data.reason").value("DUPLICATE"));
    }

    @Test
    void liveLocationsRequiresManager() throws Exception {
        seedEmployee();
        seedManager();
        String emp = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        mockMvc.perform(get("/api/v1/admin/live-locations").header("Authorization", emp))
                .andExpect(status().isForbidden());
        punchIn(emp);
        String mgr = bearer(login("MGR1001", MANAGER_PASSWORD, "MANAGER"));
        mockMvc.perform(get("/api/v1/admin/live-locations").header("Authorization", mgr))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].presence").value("live"));
    }
}
