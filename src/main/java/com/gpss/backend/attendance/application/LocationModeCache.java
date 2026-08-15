package com.gpss.backend.attendance.application;

import java.time.Instant;

import org.springframework.stereotype.Component;

import com.gpss.backend.attendance.domain.LocationMode;

@Component
public class LocationModeCache {

    private static final long TTL_NANOS = 30_000_000_000L;
    private final Object lock = new Object();
    private LocationMode cached;
    private long cachedAt;

    public LocationMode get() {
        synchronized (lock) {
            if (cached == null) {
                return null;
            }
            if (System.nanoTime() - cachedAt > TTL_NANOS) {
                return null;
            }
            return cached;
        }
    }

    public void set(LocationMode mode) {
        synchronized (lock) {
            cached = mode;
            cachedAt = System.nanoTime();
        }
    }

    public void clear() {
        synchronized (lock) {
            cached = null;
            cachedAt = 0;
        }
    }
}
