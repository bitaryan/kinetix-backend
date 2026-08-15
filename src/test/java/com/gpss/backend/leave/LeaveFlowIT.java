package com.gpss.backend.leave;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import com.gpss.backend.support.AbstractApiIT;

class LeaveFlowIT extends AbstractApiIT {

    @Test
    void applyListOverlapApprove() throws Exception {
        seedEmployee();
        seedManager();
        String emp = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        mockMvc.perform(get("/api/v1/leaves")).andExpect(status().isUnauthorized());

        var created = mockMvc.perform(post("/api/v1/leaves")
                        .header("Authorization", emp)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"start_date\":\"25/07/26\",\"end_date\":\"25/07/26\",\"reason\":\"Sick Leave\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.status").value("Pending"))
                .andExpect(jsonPath("$.data.start_date").value("25/07/26"))
                .andExpect(jsonPath("$.data.message").value("Leave application submitted successfully"))
                .andReturn();
        String id = objectMapper.readTree(created.getResponse().getContentAsString()).path("data").path("id").asText();

        mockMvc.perform(get("/api/v1/leaves").header("Authorization", emp))
                .andExpect(jsonPath("$.meta.total").value(1))
                .andExpect(jsonPath("$.data[0].status").value("Pending"));

        mockMvc.perform(post("/api/v1/leaves")
                        .header("Authorization", emp)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"start_date\":\"25/07/26\",\"end_date\":\"24/07/26\",\"reason\":\"x\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.error.code").value("INVALID_DATE_RANGE"));

        mockMvc.perform(post("/api/v1/leaves")
                        .header("Authorization", emp)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"start_date\":\"01/08/26\",\"end_date\":\"05/08/26\",\"reason\":\"First\"}"))
                .andExpect(status().isCreated());
        mockMvc.perform(post("/api/v1/leaves")
                        .header("Authorization", emp)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"start_date\":\"03/08/26\",\"end_date\":\"07/08/26\",\"reason\":\"Overlap\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("LEAVE_OVERLAP"));

        String mgr = bearer(login("MGR1001", MANAGER_PASSWORD, "MANAGER"));
        mockMvc.perform(patch("/api/v1/leaves/" + id + "/status")
                        .header("Authorization", mgr)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"APPROVED\",\"rejection_reason\":null}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("Approved"));

        mockMvc.perform(patch("/api/v1/leaves/" + id + "/status")
                        .header("Authorization", emp)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"APPROVED\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void cannotSelfApprove() throws Exception {
        seedManager();
        String mgr = bearer(login("MGR1001", MANAGER_PASSWORD, "MANAGER"));
        var created = mockMvc.perform(post("/api/v1/leaves")
                        .header("Authorization", mgr)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"start_date\":\"25/07/26\",\"end_date\":\"25/07/26\",\"reason\":\"Own leave\"}"))
                .andReturn();
        String id = objectMapper.readTree(created.getResponse().getContentAsString()).path("data").path("id").asText();
        mockMvc.perform(patch("/api/v1/leaves/" + id + "/status")
                        .header("Authorization", mgr)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"APPROVED\"}"))
                .andExpect(status().isForbidden());
    }
}
