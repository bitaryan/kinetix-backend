package com.gpss.backend.leave.infra;

import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.gpss.backend.leave.domain.Leave;
import com.gpss.backend.leave.domain.LeaveStatus;

import jakarta.persistence.LockModeType;

public interface LeaveRepository extends JpaRepository<Leave, UUID> {

    @EntityGraph(attributePaths = "user")
    Optional<Leave> findWithUserById(UUID id);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<Leave> findLockedById(UUID id);

    Page<Leave> findByUserIdOrderByCreatedAtDesc(UUID userId, Pageable pageable);

    Page<Leave> findByUserIdAndStatusOrderByCreatedAtDesc(UUID userId, LeaveStatus status, Pageable pageable);

    Page<Leave> findAllByOrderByCreatedAtDesc(Pageable pageable);

    Page<Leave> findByStatusOrderByCreatedAtDesc(LeaveStatus status, Pageable pageable);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query(
            """
            SELECT l FROM Leave l
            WHERE l.userId = :userId
              AND l.status IN :blocking
              AND l.startDate <= :endDate
              AND l.endDate >= :startDate
            """)
    List<Leave> findOverlapping(
            @Param("userId") UUID userId,
            @Param("startDate") LocalDate startDate,
            @Param("endDate") LocalDate endDate,
            @Param("blocking") Collection<LeaveStatus> blocking);
}
