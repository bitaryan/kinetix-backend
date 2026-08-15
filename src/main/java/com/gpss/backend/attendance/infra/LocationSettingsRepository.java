package com.gpss.backend.attendance.infra;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.gpss.backend.attendance.domain.LocationSettings;

import jakarta.persistence.LockModeType;

public interface LocationSettingsRepository extends JpaRepository<LocationSettings, UUID> {

    Optional<LocationSettings> findBySingletonKey(String singletonKey);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT s FROM LocationSettings s WHERE s.singletonKey = :key")
    Optional<LocationSettings> findBySingletonKeyForUpdate(@Param("key") String key);
}
