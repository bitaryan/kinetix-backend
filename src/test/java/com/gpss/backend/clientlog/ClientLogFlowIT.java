package com.gpss.backend.clientlog;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import com.gpss.backend.support.AbstractApiIT;

class ClientLogFlowIT extends AbstractApiIT {

    @Test
    void createListSearchDelete() throws Exception {
        var employee = seedEmployee();
        seedManager();
        seedAdmin();
        String emp = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        mockMvc.perform(get("/api/v1/client-logs")).andExpect(status().isUnauthorized());

        var created = mockMvc.perform(multipart("/api/v1/client-logs")
                        .file(new MockMultipartFile("selfie", "selfie.jpg", "image/jpeg", TINY_JPEG))
                        .param("client_name", "Aryan Jain")
                        .param("company_name", "Arihant Power Solutions")
                        .param("mobile_number", "7727868603")
                        .param("mail_id", "aryanjain@gmail.com")
                        .param("date", "25/07/2026")
                        .param("latitude", "26.9124")
                        .param("longitude", "75.7873")
                        .param("accuracy", "12.5")
                        .header("Authorization", emp))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.clientName").value("Aryan Jain"))
                .andExpect(jsonPath("$.data.date").value("25/07/2026"))
                .andReturn();
        String id = objectMapper.readTree(created.getResponse().getContentAsString()).path("data").path("id").asText();

        mockMvc.perform(get("/api/v1/client-logs").header("Authorization", emp))
                .andExpect(jsonPath("$.meta.totalCount").value(1))
                .andExpect(jsonPath("$.data[0].userId").value(employee.getId().toString()));

        mockMvc.perform(multipart("/api/v1/client-logs")
                        .param("client_name", "Solar Co")
                        .param("company_name", "Arihant")
                        .param("mobile_number", "7727868603")
                        .param("mail_id", "a@b.com")
                        .param("date", "25/07/2026")
                        .header("Authorization", emp))
                .andExpect(status().isCreated());
        mockMvc.perform(multipart("/api/v1/client-logs")
                        .param("client_name", "Solar%Co")
                        .param("company_name", "Literal Percent")
                        .param("mobile_number", "9876543210")
                        .param("mail_id", "percent@example.com")
                        .param("date", "25/07/2026")
                        .header("Authorization", emp))
                .andExpect(status().isCreated());
        mockMvc.perform(get("/api/v1/client-logs").param("search", "Solar%").header("Authorization", emp))
                .andExpect(jsonPath("$.meta.totalCount").value(1))
                .andExpect(jsonPath("$.data[0].clientName").value("Solar%Co"));

        String mgr = bearer(login("MGR1001", MANAGER_PASSWORD, "MANAGER"));
        mockMvc.perform(delete("/api/v1/client-logs/" + id).header("Authorization", mgr))
                .andExpect(status().isNotFound());
        mockMvc.perform(delete("/api/v1/client-logs/" + id).header("Authorization", emp))
                .andExpect(status().isForbidden());
        String admin = bearer(login("ADM1001", ADMIN_PASSWORD, "ADMIN"));
        mockMvc.perform(delete("/api/v1/client-logs/" + id).header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.message").value("Client log deleted successfully"));
    }
}
