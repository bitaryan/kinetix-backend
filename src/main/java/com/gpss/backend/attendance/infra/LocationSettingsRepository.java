package com.gpss.backend.attendance.infra;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;

import com.gpss.backend.attendance.domain.LocationSettings;

import jakarta.persistence.LockModeType;

public interface LocationSettingsRepository extends JpaRepository<LocationSettings, UUID> {

    Optional<LocationSettings> findBySingletonKey(String singletonKey);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<LocationSettings> findLockedBySingletonKey(String key);
}
