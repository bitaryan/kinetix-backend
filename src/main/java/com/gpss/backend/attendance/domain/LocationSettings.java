package com.gpss.backend.attendance.domain;

import java.time.Instant;
import java.util.UUID;

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
@Table(name = "location_settings")
public class LocationSettings {

    @Id
    @Column(name = "settings_id", nullable = false)
    private UUID id;

    @Column(name = "singleton_key", nullable = false, unique = true, length = 32)
    private String singletonKey = "default";

    @Enumerated(EnumType.STRING)
    @JdbcTypeCode(SqlTypes.NAMED_ENUM)
    @Column(name = "location_mode", nullable = false, columnDefinition = "location_mode")
    private LocationMode locationMode = LocationMode.continuous;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @PrePersist
    void assignId() {
        if (id == null) {
            id = UUID.randomUUID();
        }
    }

    public UUID getId() {
        return id;
    }

    public String getSingletonKey() {
        return singletonKey;
    }

    public void setSingletonKey(String singletonKey) {
        this.singletonKey = singletonKey;
    }

    public LocationMode getLocationMode() {
        return locationMode;
    }

    public void setLocationMode(LocationMode locationMode) {
        this.locationMode = locationMode;
    }
}
