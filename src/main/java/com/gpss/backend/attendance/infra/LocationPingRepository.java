package com.gpss.backend.attendance.infra;

import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.gpss.backend.attendance.domain.LocationPing;

public interface LocationPingRepository extends JpaRepository<LocationPing, UUID> {

    Optional<LocationPing> findByAttendanceSessionIdAndClientEventId(UUID sessionId, UUID clientEventId);
}
