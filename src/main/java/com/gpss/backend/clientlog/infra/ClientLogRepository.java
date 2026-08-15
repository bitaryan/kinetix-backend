package com.gpss.backend.clientlog.infra;

import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.gpss.backend.clientlog.domain.ClientLog;

public interface ClientLogRepository extends JpaRepository<ClientLog, UUID> {

    Page<ClientLog> findByUserIdOrderByLogDateDescCreatedAtDesc(UUID userId, Pageable pageable);

    @Query(
            """
            SELECT c FROM ClientLog c
            WHERE c.userId = :userId
              AND (
                    LOWER(c.clientName) LIKE LOWER(CONCAT('%', :escaped, '%')) ESCAPE '\\'
                 OR LOWER(c.companyName) LIKE LOWER(CONCAT('%', :escaped, '%')) ESCAPE '\\'
                 OR LOWER(c.mobileNumber) LIKE LOWER(CONCAT('%', :escaped, '%')) ESCAPE '\\'
                 OR LOWER(c.mailId) LIKE LOWER(CONCAT('%', :escaped, '%')) ESCAPE '\\'
              )
            """)
    Page<ClientLog> searchForUser(
            @Param("userId") UUID userId, @Param("escaped") String escaped, Pageable pageable);
}
