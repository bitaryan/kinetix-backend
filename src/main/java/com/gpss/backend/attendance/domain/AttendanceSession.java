package com.gpss.backend.attendance.domain;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

@Entity
@Table(name = "attendance_sessions")
public class AttendanceSession {

    @Id
    @Column(name = "session_id", nullable = false)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.NAMED_ENUM)
    @Column(name = "status", nullable = false, columnDefinition = "attendance_status")
    private AttendanceStatus status;

    @Column(name = "opening_odo_km", nullable = false, precision = 10, scale = 2)
    private BigDecimal openingOdoKm;

    @Column(name = "opening_selfie_path", nullable = false, length = 512)
    private String openingSelfiePath;

    @Column(name = "opening_odo_image_path", nullable = false, length = 512)
    private String openingOdoImagePath;

    @Column(name = "closing_odo_km", precision = 10, scale = 2)
    private BigDecimal closingOdoKm;

    @Column(name = "closing_odo_image_path", length = 512)
    private String closingOdoImagePath;

    @Column(name = "punch_in_latitude", nullable = false)
    private double punchInLatitude;

    @Column(name = "punch_in_longitude", nullable = false)
    private double punchInLongitude;

    @Column(name = "punch_in_accuracy")
    private Double punchInAccuracy;

    @Column(name = "punch_out_latitude")
    private Double punchOutLatitude;

    @Column(name = "punch_out_longitude")
    private Double punchOutLongitude;

    @Column(name = "punch_out_accuracy")
    private Double punchOutAccuracy;

    @Column(name = "punched_in_at", nullable = false)
    private Instant punchedInAt;

    @Column(name = "punched_out_at")
    private Instant punchedOutAt;

    @Column(name = "ping_count", nullable = false)
    private int pingCount;

    @Column(name = "last_known_latitude")
    private Double lastKnownLatitude;

    @Column(name = "last_known_longitude")
    private Double lastKnownLongitude;

    @Column(name = "last_known_accuracy")
    private Double lastKnownAccuracy;

    @Column(name = "last_known_captured_at")
    private Instant lastKnownCapturedAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @PrePersist
    void assignId() {
        if (id == null) {
            id = UUID.randomUUID();
        }
    }

    public void recordAcceptedPing(double lat, double lng, Double accuracy, Instant capturedAt) {
        pingCount += 1;
        lastKnownLatitude = lat;
        lastKnownLongitude = lng;
        lastKnownAccuracy = accuracy;
        lastKnownCapturedAt = capturedAt;
    }

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public UUID getUserId() {
        return userId;
    }

    public void setUserId(UUID userId) {
        this.userId = userId;
    }

    public AttendanceStatus getStatus() {
        return status;
    }

    public void setStatus(AttendanceStatus status) {
        this.status = status;
    }

    public BigDecimal getOpeningOdoKm() {
        return openingOdoKm;
    }

    public void setOpeningOdoKm(BigDecimal openingOdoKm) {
        this.openingOdoKm = openingOdoKm;
    }

    public String getOpeningSelfiePath() {
        return openingSelfiePath;
    }

    public void setOpeningSelfiePath(String openingSelfiePath) {
        this.openingSelfiePath = openingSelfiePath;
    }

    public String getOpeningOdoImagePath() {
        return openingOdoImagePath;
    }

    public void setOpeningOdoImagePath(String openingOdoImagePath) {
        this.openingOdoImagePath = openingOdoImagePath;
    }

    public BigDecimal getClosingOdoKm() {
        return closingOdoKm;
    }

    public void setClosingOdoKm(BigDecimal closingOdoKm) {
        this.closingOdoKm = closingOdoKm;
    }

    public String getClosingOdoImagePath() {
        return closingOdoImagePath;
    }

    public void setClosingOdoImagePath(String closingOdoImagePath) {
        this.closingOdoImagePath = closingOdoImagePath;
    }

    public double getPunchInLatitude() {
        return punchInLatitude;
    }

    public void setPunchInLatitude(double punchInLatitude) {
        this.punchInLatitude = punchInLatitude;
    }

    public double getPunchInLongitude() {
        return punchInLongitude;
    }

    public void setPunchInLongitude(double punchInLongitude) {
        this.punchInLongitude = punchInLongitude;
    }

    public Double getPunchInAccuracy() {
        return punchInAccuracy;
    }

    public void setPunchInAccuracy(Double punchInAccuracy) {
        this.punchInAccuracy = punchInAccuracy;
    }

    public Double getPunchOutLatitude() {
        return punchOutLatitude;
    }

    public void setPunchOutLatitude(Double punchOutLatitude) {
        this.punchOutLatitude = punchOutLatitude;
    }

    public Double getPunchOutLongitude() {
        return punchOutLongitude;
    }

    public void setPunchOutLongitude(Double punchOutLongitude) {
        this.punchOutLongitude = punchOutLongitude;
    }

    public Double getPunchOutAccuracy() {
        return punchOutAccuracy;
    }

    public void setPunchOutAccuracy(Double punchOutAccuracy) {
        this.punchOutAccuracy = punchOutAccuracy;
    }

    public Instant getPunchedInAt() {
        return punchedInAt;
    }

    public void setPunchedInAt(Instant punchedInAt) {
        this.punchedInAt = punchedInAt;
    }

    public Instant getPunchedOutAt() {
        return punchedOutAt;
    }

    public void setPunchedOutAt(Instant punchedOutAt) {
        this.punchedOutAt = punchedOutAt;
    }

    public int getPingCount() {
        return pingCount;
    }

    public void setPingCount(int pingCount) {
        this.pingCount = pingCount;
    }

    public Double getLastKnownLatitude() {
        return lastKnownLatitude;
    }

    public Double getLastKnownLongitude() {
        return lastKnownLongitude;
    }

    public Double getLastKnownAccuracy() {
        return lastKnownAccuracy;
    }

    public Instant getLastKnownCapturedAt() {
        return lastKnownCapturedAt;
    }
}
