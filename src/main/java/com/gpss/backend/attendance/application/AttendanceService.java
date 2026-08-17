package com.gpss.backend.attendance.application;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import com.gpss.backend.attendance.domain.AttendanceSession;
import com.gpss.backend.attendance.domain.AttendanceStatus;
import com.gpss.backend.attendance.domain.LocationMode;
import com.gpss.backend.attendance.domain.LocationPing;
import com.gpss.backend.attendance.domain.LocationSettings;
import com.gpss.backend.attendance.infra.AttendanceSessionRepository;
import com.gpss.backend.attendance.infra.LocationPingRepository;
import com.gpss.backend.attendance.infra.LocationSettingsRepository;
import com.gpss.backend.attendance.web.LocationPingBatchData;
import com.gpss.backend.attendance.web.LocationPingBatchData.LocationPingBatchItemData;
import com.gpss.backend.attendance.web.LocationPingData;
import com.gpss.backend.attendance.web.LocationPingDtos.LocationPingBatchRequest;
import com.gpss.backend.attendance.web.LocationPingDtos.LocationPingPoint;
import com.gpss.backend.attendance.web.LocationPingDtos.LocationPingRequest;
import com.gpss.backend.auth.infra.UserRepository;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.common.time.InstantParse;
import com.gpss.backend.config.AppProperties;
import com.gpss.backend.live.LiveLocationHub;
import com.gpss.backend.upload.ImageStorageService;

@Service
public class AttendanceService {

    private static final Duration MAX_CLOCK_SKEW = Duration.ofHours(24);
    private static final String SETTINGS_KEY = "default";

    private final AttendanceSessionRepository sessions;
    private final LocationPingRepository pings;
    private final LocationSettingsRepository settingsRows;
    private final UserRepository users;
    private final ImageStorageService images;
    private final AppProperties properties;
    private final LocationModeCache modeCache;
    private final LiveLocationHub liveHub;

    public AttendanceService(
            AttendanceSessionRepository sessions,
            LocationPingRepository pings,
            LocationSettingsRepository settingsRows,
            UserRepository users,
            ImageStorageService images,
            AppProperties properties,
            LocationModeCache modeCache,
            LiveLocationHub liveHub) {
        this.sessions = sessions;
        this.pings = pings;
        this.settingsRows = settingsRows;
        this.users = users;
        this.images = images;
        this.properties = properties;
        this.modeCache = modeCache;
        this.liveHub = liveHub;
    }

    public LocationMode resolveLocationMode() {
        LocationMode cached = modeCache.get();
        if (cached != null) {
            return cached;
        }
        LocationMode mode = settingsRows
                .findBySingletonKey(SETTINGS_KEY)
                .map(LocationSettings::getLocationMode)
                .orElse(LocationMode.continuous);
        modeCache.set(mode);
        return mode;
    }

    @Transactional(readOnly = true)
    public AttendanceSession current(UUID userId) {
        return sessions.findFirstByUserIdAndStatusOrderByPunchedInAtDesc(userId, AttendanceStatus.punched_in)
                .orElse(null);
    }

    @Transactional
    public PunchInResult punchIn(
            UUID userId,
            BigDecimal openingOdoKm,
            double latitude,
            double longitude,
            Double accuracy,
            String capturedAtRaw,
            MultipartFile selfie,
            MultipartFile openingOdoImage) {
        users.findLockedById(userId)
                .orElseThrow(() -> new ApiException(401, "UNAUTHORIZED", "User account is unavailable"));
        List<AttendanceSession> existing =
                sessions.findLockedByUserIdAndStatusOrderByPunchedInAtDesc(userId, AttendanceStatus.punched_in);
        if (!existing.isEmpty()) {
            throw new ApiException(409, "ALREADY_PUNCHED_IN", "An active punch-in session already exists");
        }
        LocationMode mode = resolveLocationMode();
        Instant now = Instant.now();
        Instant capturedAt = now;
        if (capturedAtRaw != null && !capturedAtRaw.isBlank()) {
            capturedAt = InstantParse.requireOffset(capturedAtRaw);
            if (isStale(capturedAt, now)) {
                throw new ApiException(400, "STALE_TIMESTAMP", "capturedAt is too far from server time");
            }
        }
        UUID sessionId = UUID.randomUUID();
        List<String> saved = new ArrayList<>();
        try {
            String selfiePath = images.saveAttendanceImage(selfie, userId, sessionId, "selfie");
            saved.add(selfiePath);
            String odoPath = images.saveAttendanceImage(openingOdoImage, userId, sessionId, "opening_odo");
            saved.add(odoPath);
            AttendanceSession session = new AttendanceSession();
            session.setId(sessionId);
            session.setUserId(userId);
            session.setStatus(AttendanceStatus.punched_in);
            session.setOpeningOdoKm(openingOdoKm.setScale(2, RoundingMode.HALF_UP));
            session.setOpeningSelfiePath(selfiePath);
            session.setOpeningOdoImagePath(odoPath);
            session.setPunchInLatitude(latitude);
            session.setPunchInLongitude(longitude);
            session.setPunchInAccuracy(accuracy);
            session.setPunchedInAt(now);
            LocationPing ping = newPing(sessionId, latitude, longitude, accuracy, capturedAt, null, null, null, null);
            session.recordAcceptedPing(latitude, longitude, accuracy, capturedAt);
            sessions.save(session);
            pings.save(ping);
            liveHub.publish(session, userId);
            return new PunchInResult(session, mode);
        } catch (DataIntegrityViolationException ex) {
            images.deleteStoredFiles(saved.toArray(String[]::new));
            throw new ApiException(409, "ALREADY_PUNCHED_IN", "An active punch-in session already exists");
        } catch (RuntimeException ex) {
            images.deleteStoredFiles(saved.toArray(String[]::new));
            throw ex;
        }
    }

    @Transactional
    public LocationPingData locationPing(UUID userId, LocationPingRequest payload) {
        LocationMode mode = resolveLocationMode();
        AttendanceSession session = sessions.findLockedById(payload.sessionId()).orElse(null);
        if (session == null || !session.getUserId().equals(userId)) {
            return new LocationPingData(false, "SESSION_NOT_FOUND", null, mode);
        }
        PingOutcome outcome = evaluatePoint(session, payload.asPoint(), session.getLastKnownCapturedAt(), mode, Instant.now());
        if (!outcome.accepted) {
            return new LocationPingData(false, outcome.reason, outcome.pingId, mode);
        }
        if (outcome.duplicate) {
            return new LocationPingData(true, "DUPLICATE", outcome.pingId, mode);
        }
        LocationPing ping = persistAccepted(session, payload.asPoint(), outcome.capturedAt);
        liveHub.publish(session, userId);
        return new LocationPingData(true, null, ping.getId(), mode);
    }

    @Transactional
    public LocationPingBatchData locationPingBatch(UUID userId, LocationPingBatchRequest payload) {
        if (payload.pings().size() > properties.getLocationPingBatchMax()) {
            throw new ApiException(422, "VALIDATION_ERROR", "Request data is invalid");
        }
        LocationMode mode = resolveLocationMode();
        AttendanceSession session = sessions.findLockedById(payload.sessionId()).orElse(null);
        int n = payload.pings().size();
        if (session == null || !session.getUserId().equals(userId)) {
            return rejectAll(n, "SESSION_NOT_FOUND", mode);
        }
        if (mode == LocationMode.single) {
            return rejectAll(n, "SINGLE_LOCATION_MODE", mode);
        }
        Instant now = Instant.now();
        Instant lastCaptured = session.getLastKnownCapturedAt();
        List<IndexedPoint> ordered = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            ordered.add(new IndexedPoint(i, payload.pings().get(i)));
        }
        ordered.sort(Comparator.comparing(item -> sortKey(item.point.capturedAt())));
        Map<Integer, LocationPingBatchItemData> byIndex = new HashMap<>();
        boolean published = false;
        for (IndexedPoint item : ordered) {
            PingOutcome outcome = evaluatePoint(session, item.point, lastCaptured, mode, now);
            if (!outcome.accepted) {
                byIndex.put(item.index, new LocationPingBatchItemData(item.index, false, outcome.reason, null));
                continue;
            }
            if (outcome.duplicate) {
                byIndex.put(item.index, new LocationPingBatchItemData(item.index, true, "DUPLICATE", outcome.pingId));
                continue;
            }
            LocationPing ping = persistAccepted(session, item.point, outcome.capturedAt);
            lastCaptured = outcome.capturedAt;
            byIndex.put(item.index, new LocationPingBatchItemData(item.index, true, null, ping.getId()));
            published = true;
        }
        if (published) {
            liveHub.publish(session, userId);
        }
        List<LocationPingBatchItemData> items = new ArrayList<>();
        int accepted = 0;
        for (int i = 0; i < n; i++) {
            LocationPingBatchItemData row = byIndex.get(i);
            items.add(row);
            if (row.accepted()) {
                accepted++;
            }
        }
        return new LocationPingBatchData(accepted, n - accepted, mode, items);
    }

    @Transactional
    public AttendanceSession punchOut(
            UUID userId,
            BigDecimal closingOdoKm,
            double latitude,
            double longitude,
            Double accuracy,
            String capturedAtRaw,
            MultipartFile closingOdoImage) {
        users.findLockedById(userId)
                .orElseThrow(() -> new ApiException(401, "UNAUTHORIZED", "User account is unavailable"));
        List<AttendanceSession> active =
                sessions.findLockedByUserIdAndStatusOrderByPunchedInAtDesc(userId, AttendanceStatus.punched_in);
        if (active.isEmpty()) {
            throw new ApiException(409, "NOT_PUNCHED_IN", "No active punch-in session to close");
        }
        AttendanceSession session = active.get(0);
        if (closingOdoKm.compareTo(session.getOpeningOdoKm()) < 0) {
            throw new ApiException(
                    400,
                    "INVALID_ODO_READING",
                    "Closing odometer must be greater than or equal to opening odometer");
        }
        Instant now = Instant.now();
        Instant capturedAt = now;
        if (capturedAtRaw != null && !capturedAtRaw.isBlank()) {
            capturedAt = InstantParse.requireOffset(capturedAtRaw);
            if (isStale(capturedAt, now)) {
                throw new ApiException(400, "STALE_TIMESTAMP", "capturedAt is too far from server time");
            }
        }
        List<String> saved = new ArrayList<>();
        try {
            String odoPath = images.saveAttendanceImage(closingOdoImage, userId, session.getId(), "closing_odo");
            saved.add(odoPath);
            session.setStatus(AttendanceStatus.punched_out);
            session.setClosingOdoKm(closingOdoKm.setScale(2, RoundingMode.HALF_UP));
            session.setClosingOdoImagePath(odoPath);
            session.setPunchOutLatitude(latitude);
            session.setPunchOutLongitude(longitude);
            session.setPunchOutAccuracy(accuracy);
            session.setPunchedOutAt(now);
            LocationMode mode = resolveLocationMode();
            if (mode == LocationMode.continuous
                    && session.getPingCount() < properties.getLocationPingMaxPerSession()) {
                LocationPing ping =
                        newPing(session.getId(), latitude, longitude, accuracy, capturedAt, null, null, null, null);
                session.recordAcceptedPing(latitude, longitude, accuracy, capturedAt);
                pings.save(ping);
            }
            liveHub.publish(session, userId);
            return session;
        } catch (RuntimeException ex) {
            images.deleteStoredFiles(saved.toArray(String[]::new));
            throw ex;
        }
    }

    @Transactional
    public LocationMode updateLocationMode(LocationMode mode) {
        LocationSettings row = settingsRows
                .findLockedBySingletonKey(SETTINGS_KEY)
                .orElseGet(() -> {
                    LocationSettings created = new LocationSettings();
                    created.setSingletonKey(SETTINGS_KEY);
                    created.setLocationMode(LocationMode.continuous);
                    return settingsRows.save(created);
                });
        row.setLocationMode(mode);
        modeCache.set(mode);
        return mode;
    }

    private LocationPing persistAccepted(AttendanceSession session, LocationPingPoint point, Instant capturedAt) {
        LocationPing ping = newPing(
                session.getId(),
                point.latitude(),
                point.longitude(),
                point.accuracy(),
                capturedAt,
                point.battery(),
                point.speed(),
                point.clientEventId(),
                point.isMock());
        if (point.accuracy() != null && point.accuracy() > properties.getLocationPingMaxAccuracyMeters()) {
            ping.setAccuracyFlag("LOW_ACCURACY");
        }
        pings.save(ping);
        session.recordAcceptedPing(point.latitude(), point.longitude(), point.accuracy(), capturedAt);
        return ping;
    }

    private PingOutcome evaluatePoint(
            AttendanceSession session,
            LocationPingPoint point,
            Instant lastCaptured,
            LocationMode mode,
            Instant now) {
        if (point.clientEventId() != null) {
            var existing =
                    pings.findByAttendanceSessionIdAndClientEventId(session.getId(), point.clientEventId());
            if (existing.isPresent()) {
                return PingOutcome.duplicate(existing.get().getId());
            }
        }
        boolean inSessionWindow = session.getStatus() == AttendanceStatus.punched_in
                || (session.getStatus() == AttendanceStatus.punched_out
                        && session.getPunchedOutAt() != null
                        && parseAware(point.capturedAt()) != null
                        && !parseAware(point.capturedAt()).isAfter(session.getPunchedOutAt())
                        && !parseAware(point.capturedAt()).isBefore(session.getPunchedInAt()));
        if (session.getStatus() != AttendanceStatus.punched_in && !inSessionWindow) {
            return PingOutcome.reject("SESSION_NOT_ACTIVE");
        }
        if (session.getStatus() == AttendanceStatus.punched_out && !inSessionWindow) {
            return PingOutcome.reject("SESSION_NOT_ACTIVE");
        }
        if (mode == LocationMode.single) {
            return PingOutcome.reject("SINGLE_LOCATION_MODE");
        }
        if (session.getPingCount() >= properties.getLocationPingMaxPerSession()) {
            return PingOutcome.reject("SESSION_TRAIL_FULL");
        }
        Instant capturedAt = parseAware(point.capturedAt());
        if (capturedAt == null) {
            return PingOutcome.reject("INVALID_TIMESTAMP");
        }
        if (isStale(capturedAt, now)) {
            return PingOutcome.reject("STALE_PING");
        }
        if (point.accuracy() != null && point.accuracy() > properties.getLocationPingMaxAccuracyMeters()) {
            return PingOutcome.reject("LOW_ACCURACY");
        }
        double minInterval = properties.getLocationPingMinIntervalSeconds();
        if (lastCaptured != null
                && minInterval > 0
                && Duration.between(lastCaptured, capturedAt).toNanos() < (long) (minInterval * 1_000_000_000L)) {
            return PingOutcome.reject("TOO_FREQUENT");
        }
        return PingOutcome.accept(capturedAt);
    }

    private static Instant parseAware(String raw) {
        return InstantParse.tryParseAware(raw);
    }

    private static boolean isStale(Instant capturedAt, Instant now) {
        return Duration.between(capturedAt, now).abs().compareTo(MAX_CLOCK_SKEW) > 0;
    }

    private static double sortKey(String capturedAt) {
        Instant parsed = InstantParse.tryParseAware(capturedAt);
        return parsed == null ? Double.NEGATIVE_INFINITY : parsed.toEpochMilli();
    }

    private static LocationPing newPing(
            UUID sessionId,
            double lat,
            double lng,
            Double accuracy,
            Instant capturedAt,
            Double battery,
            Double speed,
            UUID clientEventId,
            Boolean mock) {
        LocationPing ping = new LocationPing();
        ping.setAttendanceSessionId(sessionId);
        ping.setLatitude(lat);
        ping.setLongitude(lng);
        ping.setAccuracy(accuracy);
        ping.setCapturedAt(capturedAt);
        ping.setBattery(battery);
        ping.setSpeed(speed);
        ping.setClientEventId(clientEventId);
        ping.setMock(mock);
        return ping;
    }

    private static LocationPingBatchData rejectAll(int n, String reason, LocationMode mode) {
        List<LocationPingBatchItemData> items = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            items.add(new LocationPingBatchItemData(i, false, reason, null));
        }
        return new LocationPingBatchData(0, n, mode, items);
    }

    public record PunchInResult(AttendanceSession session, LocationMode locationMode) {}

    private record IndexedPoint(int index, LocationPingPoint point) {}

    private static final class PingOutcome {
        final boolean accepted;
        final boolean duplicate;
        final String reason;
        final Instant capturedAt;
        final UUID pingId;

        private PingOutcome(boolean accepted, boolean duplicate, String reason, Instant capturedAt, UUID pingId) {
            this.accepted = accepted;
            this.duplicate = duplicate;
            this.reason = reason;
            this.capturedAt = capturedAt;
            this.pingId = pingId;
        }

        static PingOutcome accept(Instant capturedAt) {
            return new PingOutcome(true, false, null, capturedAt, null);
        }

        static PingOutcome duplicate(UUID pingId) {
            return new PingOutcome(true, true, "DUPLICATE", null, pingId);
        }

        static PingOutcome reject(String reason) {
            return new PingOutcome(false, false, reason, null, null);
        }
    }
}
