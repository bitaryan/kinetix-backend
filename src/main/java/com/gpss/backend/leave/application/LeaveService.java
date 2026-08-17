package com.gpss.backend.leave.application;

import java.time.LocalDate;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.auth.infra.UserRepository;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.leave.domain.Leave;
import com.gpss.backend.leave.domain.LeaveStatus;
import com.gpss.backend.leave.infra.LeaveRepository;

@Service
public class LeaveService {

    private static final Set<LeaveStatus> BLOCKING = Set.of(LeaveStatus.PENDING, LeaveStatus.APPROVED);

    private final LeaveRepository leaves;
    private final UserRepository users;

    public LeaveService(LeaveRepository leaves, UserRepository users) {
        this.leaves = leaves;
        this.users = users;
    }

    @Transactional(readOnly = true)
    public Page<Leave> list(User principal, int page, int limit, LeaveStatus status) {
        PageRequest pageable = PageRequest.of(page - 1, limit);
        boolean scoped = principal.getRole() == UserRole.EMPLOYEE;
        if (scoped) {
            return status == null
                    ? leaves.findByUserIdOrderByCreatedAtDesc(principal.getId(), pageable)
                    : leaves.findByUserIdAndStatusOrderByCreatedAtDesc(principal.getId(), status, pageable);
        }
        return status == null
                ? leaves.findAllByOrderByCreatedAtDesc(pageable)
                : leaves.findByStatusOrderByCreatedAtDesc(status, pageable);
    }

    @Transactional(readOnly = true)
    public Leave get(UUID leaveId, User principal) {
        Leave leave = leaves.findWithUserById(leaveId).orElse(null);
        if (leave == null) {
            throw new ApiException(404, "NOT_FOUND", "Leave application not found");
        }
        if (principal.getRole() == UserRole.EMPLOYEE && !leave.getUserId().equals(principal.getId())) {
            throw new ApiException(404, "NOT_FOUND", "Leave application not found");
        }
        return leave;
    }

    @Transactional
    public Leave apply(User user, LocalDate start, LocalDate end, String reason) {
        User locked = users.findLockedById(user.getId()).orElse(null);
        if (locked == null || !locked.isActive()) {
            throw new ApiException(401, "UNAUTHORIZED", "User account is unavailable");
        }
        List<Leave> overlapping = leaves.findOverlapping(user.getId(), start, end, BLOCKING);
        if (!overlapping.isEmpty()) {
            throw new ApiException(
                    409, "LEAVE_OVERLAP", "A leave application already exists for overlapping dates");
        }
        Leave leave = new Leave();
        leave.setUserId(user.getId());
        leave.setStartDate(start);
        leave.setEndDate(end);
        leave.setReason(reason);
        leave.setStatus(LeaveStatus.PENDING);
        return leaves.save(leave);
    }

    @Transactional
    public Leave updateStatus(UUID leaveId, User actor, LeaveStatus status, String rejectionReason) {
        if (actor.getRole() != UserRole.MANAGER && actor.getRole() != UserRole.ADMIN) {
            throw new ApiException(403, "FORBIDDEN", "You do not have permission for this action");
        }
        Leave leave = leaves.findLockedById(leaveId)
                .orElseThrow(() -> new ApiException(404, "NOT_FOUND", "Leave application not found"));
        if (leave.getUserId().equals(actor.getId())) {
            throw new ApiException(
                    403, "FORBIDDEN", "You cannot approve or reject your own leave application");
        }
        if (leave.getStatus() != LeaveStatus.PENDING) {
            throw new ApiException(409, "INVALID_LEAVE_STATE", "Only pending leave applications can be updated");
        }
        leave.setStatus(status);
        leave.setApprovedBy(actor.getId());
        leave.setRejectionReason(status == LeaveStatus.REJECTED ? rejectionReason : null);
        return leave;
    }
}
