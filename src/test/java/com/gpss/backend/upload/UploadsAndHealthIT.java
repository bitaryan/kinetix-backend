package com.gpss.backend.upload;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.gpss.backend.support.AbstractApiIT;

class UploadsAndHealthIT extends AbstractApiIT {

    @Test
    void employeeOwnFileManagerAny() throws Exception {
        var employee = seedEmployee();
        seedManager();
        UUID session = UUID.randomUUID();
        Path relative = Path.of("attendance", employee.getId().toString(), session.toString(), "selfie.jpg");
        Path absolute = Path.of("uploads/test").resolve(relative);
        Files.createDirectories(absolute.getParent());
        Files.write(absolute, TINY_JPEG);

        mockMvc.perform(get("/uploads/" + relative.toString().replace('\\', '/')))
                .andExpect(status().isUnauthorized());

        String emp = bearer(login("EMP1001", EMPLOYEE_PASSWORD, "EMPLOYEE"));
        mockMvc.perform(get("/uploads/" + relative.toString().replace('\\', '/')).header("Authorization", emp))
                .andExpect(status().isOk());

        Path other = Path.of("uploads/test", "attendance", UUID.randomUUID().toString(), UUID.randomUUID().toString(), "selfie.jpg");
        Files.createDirectories(other.getParent());
        Files.write(other, TINY_JPEG);
        mockMvc.perform(get("/uploads/"
                                + Path.of("uploads/test").relativize(other).toString().replace('\\', '/'))
                        .header("Authorization", emp))
                .andExpect(status().isNotFound());

        String mgr = bearer(login("MGR1001", MANAGER_PASSWORD, "MANAGER"));
        mockMvc.perform(get("/uploads/" + relative.toString().replace('\\', '/')).header("Authorization", mgr))
                .andExpect(status().isOk());
    }
}
