package com.gpss.backend.live;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.gpss.backend.attendance.domain.AttendanceSession;
import com.gpss.backend.attendance.domain.AttendanceStatus;
import com.gpss.backend.attendance.infra.AttendanceSessionRepository;
import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.infra.UserRepository;
import com.gpss.backend.config.AppProperties;

@Component
public class LiveLocationHub {

    public static final String TOPIC = "/topic/live-locations";

    private final AttendanceSessionRepository sessions;
    private final UserRepository users;
    private final AppProperties properties;
    private final SimpMessagingTemplate messaging;

    public LiveLocationHub(
            AttendanceSessionRepository sessions,
            UserRepository users,
            AppProperties properties,
            SimpMessagingTemplate messaging) {
        this.sessions = sessions;
        this.users = users;
        this.properties = properties;
        this.messaging = messaging;
    }

    public List<LiveLocationDto> snapshot() {
        List<AttendanceSession> active =
                sessions.findByStatusAndLastKnownCapturedAtIsNotNull(AttendanceStatus.punched_in);
        List<LiveLocationDto> out = new ArrayList<>();
        Instant now = Instant.now();
        for (AttendanceSession session : active) {
            users.findById(session.getUserId()).ifPresent(user -> out.add(toDto(session, user, now)));
        }
        return out;
    }

    public void publish(AttendanceSession session, UUID userId) {
        if (session.getLastKnownCapturedAt() == null) {
            return;
        }
        User user = users.findById(userId).orElse(null);
        if (user == null) {
            return;
        }
        messaging.convertAndSend(TOPIC, toDto(session, user, Instant.now()));
    }

    private LiveLocationDto toDto(AttendanceSession session, User user, Instant now) {
        return new LiveLocationDto(
                session.getId(),
                user.getId(),
                user.getEmployeeId(),
                user.getEmployeeName(),
                session.getLastKnownLatitude(),
                session.getLastKnownLongitude(),
                session.getLastKnownAccuracy(),
                session.getLastKnownCapturedAt(),
                presence(session.getLastKnownCapturedAt(), now),
                session.getStatus().name());
    }

    private String presence(Instant lastKnown, Instant now) {
        long age = Duration.between(lastKnown, now).getSeconds();
        if (age > properties.getLiveOfflineAfterSeconds()) {
            return "offline";
        }
        if (age > properties.getLiveStaleAfterSeconds()) {
            return "stale";
        }
        return "live";
    }

    public record LiveLocationDto(
            @JsonProperty("sessionId") UUID sessionId,
            @JsonProperty("userId") UUID userId,
            @JsonProperty("employeeId") String employeeId,
            @JsonProperty("employeeName") String employeeName,
            Double latitude,
            Double longitude,
            Double accuracy,
            @JsonProperty("capturedAt") Instant capturedAt,
            String presence,
            String status) {}
}
