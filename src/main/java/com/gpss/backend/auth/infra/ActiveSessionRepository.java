package com.gpss.backend.auth.infra;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.gpss.backend.auth.domain.ActiveSession;

import jakarta.persistence.LockModeType;

public interface ActiveSessionRepository extends JpaRepository<ActiveSession, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<ActiveSession> findLockedByRefreshTokenHash(String hash);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<ActiveSession> findLockedByPreviousRefreshTokenHash(String hash);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("UPDATE ActiveSession s SET s.revoked = true WHERE s.userId = :userId AND s.revoked = false")
    int revokeForUser(@Param("userId") UUID userId);
}
