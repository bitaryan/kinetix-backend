package com.gpss.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.cookie;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import com.gpss.backend.support.AbstractApiIT;

class AuthFlowIT extends AbstractApiIT {

    @Test
    void healthOk() throws Exception {
        mockMvc.perform(get("/health"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.status").value("ok"))
                .andExpect(jsonPath("$.error").value(org.hamcrest.Matchers.nullValue()));
    }

    @Test
    void meWithoutTokenUnauthorized() throws Exception {
        mockMvc.perform(get("/api/v1/auth/me"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.data").value(org.hamcrest.Matchers.nullValue()))
                .andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"))
                .andExpect(jsonPath("$.error.message").value("A bearer access token is required"));
    }

    @Test
    void loginRejectsShortPassword() throws Exception {
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"EMP1001\",\"password\":\"short\",\"role\":\"EMPLOYEE\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void loginSuccessSetsHttpOnlyCookie() throws Exception {
        seedEmployee();
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"EMP1001\",\"password\":\"Employee-pass-12\",\"role\":\"EMPLOYEE\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.tokenType").value("bearer"))
                .andExpect(jsonPath("$.data.expiresIn").value(900))
                .andExpect(jsonPath("$.data.user.userId").value("EMP1001"))
                .andExpect(jsonPath("$.data.user.passwordHash").doesNotExist())
                .andExpect(cookie().exists("refresh_token"))
                .andExpect(cookie().httpOnly("refresh_token", true))
                .andExpect(cookie().path("refresh_token", "/api/v1/auth"));
        String setCookie = login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE")
                .getResponse()
                .getHeader("Set-Cookie");
        assertThat(setCookie.toLowerCase()).contains("httponly").contains("samesite=strict");
    }

    @Test
    void loginWrongPasswordUnknownUserWrongRole() throws Exception {
        seedEmployee();
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"EMP1001\",\"password\":\"wrong-password-xx\",\"role\":\"EMPLOYEE\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"NOSUCH1\",\"password\":\"some-password\",\"role\":\"EMPLOYEE\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":\"EMP1001\",\"password\":\"Employee-pass-12\",\"role\":\"ADMIN\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));
    }

    @Test
    void lockoutAfterFiveFailures() throws Exception {
        seedEmployee();
        for (int i = 0; i < 5; i++) {
            login("EMP1001", "wrong-password-xx", "EMPLOYEE");
        }
        var locked = login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE");
        assertThat(locked.getResponse().getStatus()).isEqualTo(401);
        assertThat(objectMapper.readTree(locked.getResponse().getContentAsString()).path("error").path("code").asText())
                .isEqualTo("INVALID_CREDENTIALS");
    }

    @Test
    void meLogoutRefreshRotationReuse() throws Exception {
        seedEmployee();
        var first = login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE");
        String token = accessToken(first);
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.userId").value("EMP1001"));

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token + "tampered"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"));

        String refresh = first.getResponse().getCookie("refresh_token").getValue();
        var refreshed = mockMvc.perform(post("/api/v1/auth/refresh").cookie(first.getResponse().getCookie("refresh_token")))
                .andExpect(status().isOk())
                .andReturn();
        String newRefresh = refreshed.getResponse().getCookie("refresh_token").getValue();
        assertThat(newRefresh).isNotEqualTo(refresh);
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + accessToken(refreshed)))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/auth/refresh").cookie(first.getResponse().getCookie("refresh_token")))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_REFRESH_TOKEN"));

        mockMvc.perform(post("/api/v1/auth/refresh"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_REFRESH_TOKEN"));
    }

    @Test
    void logoutRevokesAccess() throws Exception {
        seedEmployee();
        var login = login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE");
        mockMvc.perform(post("/api/v1/auth/logout").header("Authorization", bearer(login)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.message").value("Successfully logged out"));
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", bearer(login)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void secondLoginRevokesFirstSession() throws Exception {
        seedEmployee();
        var first = login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE");
        var second = login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE");
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", bearer(first)))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", bearer(second)))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/auth/refresh").cookie(first.getResponse().getCookie("refresh_token")))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void adminCreatesUserEmployeeForbidden() throws Exception {
        seedAdmin();
        seedEmployee();
        String admin = bearer(login("ADM1001", ADMIN_PASSWORD, "ADMIN"));
        mockMvc.perform(post("/api/v1/auth/users")
                        .header("Authorization", admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"userId":"EMP2002","employeeName":"New Hire","email":"newhire@example.com",
                                 "password":"Brand-new-pass12","role":"EMPLOYEE"}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.userId").value("EMP2002"));

        mockMvc.perform(post("/api/v1/auth/users")
                        .header("Authorization", admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"userId":"EMP1001","employeeName":"Dup","email":"dup@example.com",
                                 "password":"Brand-new-pass12","role":"EMPLOYEE"}
                                """))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("EMPLOYEE_ID_EXISTS"));

        mockMvc.perform(post("/api/v1/auth/users")
                        .header("Authorization", admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"userId":"ADM9999","employeeName":"Peer Admin","email":"peer@example.com",
                                 "password":"Brand-new-pass12","role":"ADMIN"}
                                """))
                .andExpect(status().isForbidden());

        String emp = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        mockMvc.perform(post("/api/v1/auth/users")
                        .header("Authorization", emp)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"userId":"EMP3003","employeeName":"Should Fail","email":"fail@example.com",
                                 "password":"Brand-new-pass12","role":"EMPLOYEE"}
                                """))
                .andExpect(status().isForbidden());
    }

    @Test
    void weakCreatePasswordRejected() throws Exception {
        seedAdmin();
        String admin = bearer(login("ADM1001", ADMIN_PASSWORD, "ADMIN"));
        mockMvc.perform(post("/api/v1/auth/users")
                        .header("Authorization", admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                                """
                                {"userId":"EMPWEAK1","employeeName":"Weak Pass","email":"weak@example.com",
                                 "password":"aaaaaaaaaaaa","role":"EMPLOYEE"}
                                """))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void loginRateLimit() throws Exception {
        properties.setLoginRateLimitPerMinute(3);
        rateLimiter.clear();
        for (int i = 0; i < 5; i++) {
            authService.createUser(
                    new com.gpss.backend.auth.web.CreateUserRequest(
                            "STUF%04d".formatted(i),
                            "Stuff " + i,
                            "stuff" + i + "@example.com",
                            "Correct-pass-12",
                            com.gpss.backend.auth.domain.UserRole.EMPLOYEE),
                    false);
        }
        int unauthorized = 0;
        int limited = 0;
        for (int i = 0; i < 5; i++) {
            var result = login("STUF%04d".formatted(i), "wrong-password-xx", "EMPLOYEE");
            if (result.getResponse().getStatus() == 401) {
                unauthorized++;
            }
            if (result.getResponse().getStatus() == 429) {
                limited++;
            }
        }
        assertThat(unauthorized).isPositive();
        assertThat(limited).isPositive();
    }
}
