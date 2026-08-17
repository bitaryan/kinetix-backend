package com.gpss.backend.auth.infra;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;

import com.gpss.backend.auth.domain.User;

import jakarta.persistence.LockModeType;

public interface UserRepository extends JpaRepository<User, UUID> {

    Optional<User> findByEmployeeId(String employeeId);

    Optional<User> findByEmail(String email);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<User> findLockedByEmployeeId(String employeeId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<User> findLockedById(UUID id);
}
