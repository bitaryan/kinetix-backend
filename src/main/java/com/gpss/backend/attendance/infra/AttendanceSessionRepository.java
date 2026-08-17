package com.gpss.backend.attendance.infra;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;

import com.gpss.backend.attendance.domain.AttendanceSession;
import com.gpss.backend.attendance.domain.AttendanceStatus;

import jakarta.persistence.LockModeType;

public interface AttendanceSessionRepository extends JpaRepository<AttendanceSession, UUID> {

    Optional<AttendanceSession> findFirstByUserIdAndStatusOrderByPunchedInAtDesc(
            UUID userId, AttendanceStatus status);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    List<AttendanceSession> findLockedByUserIdAndStatusOrderByPunchedInAtDesc(
            UUID userId, AttendanceStatus status);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<AttendanceSession> findLockedById(UUID id);

    List<AttendanceSession> findByStatusAndLastKnownCapturedAtIsNotNull(AttendanceStatus status);
}
