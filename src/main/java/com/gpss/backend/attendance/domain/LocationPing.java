package com.gpss.backend.attendance.domain;

import java.time.Instant;
import java.util.UUID;

import org.hibernate.annotations.CreationTimestamp;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

@Entity
@Table(name = "location_pings")
public class LocationPing {

    @Id
    @Column(name = "ping_id", nullable = false)
    private UUID id;

    @Column(name = "attendance_session_id", nullable = false)
    private UUID attendanceSessionId;

    @Column(name = "latitude", nullable = false)
    private double latitude;

    @Column(name = "longitude", nullable = false)
    private double longitude;

    @Column(name = "accuracy")
    private Double accuracy;

    @Column(name = "captured_at", nullable = false)
    private Instant capturedAt;

    @Column(name = "battery")
    private Double battery;

    @Column(name = "speed")
    private Double speed;

    @Column(name = "client_event_id")
    private UUID clientEventId;

    @Column(name = "is_mock")
    private Boolean mock;

    @Column(name = "accuracy_flag", length = 32)
    private String accuracyFlag;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @PrePersist
    void assignId() {
        if (id == null) {
            id = UUID.randomUUID();
        }
    }

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public UUID getAttendanceSessionId() {
        return attendanceSessionId;
    }

    public void setAttendanceSessionId(UUID attendanceSessionId) {
        this.attendanceSessionId = attendanceSessionId;
    }

    public double getLatitude() {
        return latitude;
    }

    public void setLatitude(double latitude) {
        this.latitude = latitude;
    }

    public double getLongitude() {
        return longitude;
    }

    public void setLongitude(double longitude) {
        this.longitude = longitude;
    }

    public Double getAccuracy() {
        return accuracy;
    }

    public void setAccuracy(Double accuracy) {
        this.accuracy = accuracy;
    }

    public Instant getCapturedAt() {
        return capturedAt;
    }

    public void setCapturedAt(Instant capturedAt) {
        this.capturedAt = capturedAt;
    }

    public Double getBattery() {
        return battery;
    }

    public void setBattery(Double battery) {
        this.battery = battery;
    }

    public Double getSpeed() {
        return speed;
    }

    public void setSpeed(Double speed) {
        this.speed = speed;
    }

    public UUID getClientEventId() {
        return clientEventId;
    }

    public void setClientEventId(UUID clientEventId) {
        this.clientEventId = clientEventId;
    }

    public Boolean getMock() {
        return mock;
    }

    public void setMock(Boolean mock) {
        this.mock = mock;
    }

    public String getAccuracyFlag() {
        return accuracyFlag;
    }

    public void setAccuracyFlag(String accuracyFlag) {
        this.accuracyFlag = accuracyFlag;
    }
}
