package com.gpss.backend.attendance.infra;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.gpss.backend.attendance.domain.AttendanceSession;
import com.gpss.backend.attendance.domain.AttendanceStatus;

import jakarta.persistence.LockModeType;

public interface AttendanceSessionRepository extends JpaRepository<AttendanceSession, UUID> {

    Optional<AttendanceSession> findFirstByUserIdAndStatusOrderByPunchedInAtDesc(
            UUID userId, AttendanceStatus status);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT s FROM AttendanceSession s WHERE s.userId = :userId AND s.status = :status ORDER BY s.punchedInAt DESC")
    List<AttendanceSession> findActiveForUserForUpdate(
            @Param("userId") UUID userId, @Param("status") AttendanceStatus status);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT s FROM AttendanceSession s WHERE s.id = :id")
    Optional<AttendanceSession> findByIdForUpdate(@Param("id") UUID id);

    List<AttendanceSession> findByStatusAndLastKnownCapturedAtIsNotNull(AttendanceStatus status);
}
