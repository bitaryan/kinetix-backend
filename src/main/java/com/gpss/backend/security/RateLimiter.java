package com.gpss.backend.security;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.config.AppProperties;

import jakarta.servlet.http.HttpServletRequest;

/**
 * In-process sliding 60s window. Not shared across instances — Redis can replace
 * this later without changing call sites.
 */
@Component
public class RateLimiter {

    private final AppProperties properties;
    private final Map<String, Deque<Long>> events = new ConcurrentHashMap<>();
    private volatile long lastCleanup = System.nanoTime();

    public RateLimiter(AppProperties properties) {
        this.properties = properties;
    }

    public void hit(String key, int limit, int cost) {
        if (limit <= 0 || cost <= 0) {
            return;
        }
        long now = System.nanoTime();
        long windowNanos = 60_000_000_000L;
        long cutoff = now - windowNanos;
        Deque<Long> bucket = events.computeIfAbsent(key, ignored -> new ArrayDeque<>());
        synchronized (bucket) {
            maybeCleanup(now, cutoff);
            while (!bucket.isEmpty() && bucket.peekFirst() <= cutoff) {
                bucket.removeFirst();
            }
            if (bucket.size() + cost > limit) {
                throw new ApiException(
                        HttpStatus.TOO_MANY_REQUESTS,
                        "RATE_LIMITED",
                        "Too many requests. Please try again later");
            }
            for (int i = 0; i < cost; i++) {
                bucket.addLast(now);
            }
        }
    }

    public void clear() {
        events.clear();
    }

    public String clientIp(HttpServletRequest request) {
        String peer = request.getRemoteAddr() == null ? "unknown" : request.getRemoteAddr();
        if (properties.trustedProxyIpList().contains(peer)) {
            String forwarded = request.getHeader("X-Forwarded-For");
            if (StringUtils.hasText(forwarded)) {
                String first = forwarded.split(",")[0].strip();
                if (StringUtils.hasText(first)) {
                    return first;
                }
            }
        }
        return peer;
    }

    public void enforceLogin(HttpServletRequest request) {
        hit("login:" + clientIp(request), properties.getLoginRateLimitPerMinute(), 1);
    }

    public void enforceRefresh(HttpServletRequest request) {
        hit("refresh:" + clientIp(request), properties.getRefreshRateLimitPerMinute(), 1);
    }

    /**
     * User bucket: 1 token per HTTP call (single ping or whole batch). A 120-point
     * offline flush therefore cannot exhaust the live-ping budget. IP bucket uses
     * the same cost with a 100× ceiling for shared NAT.
     */
    public void enforceLocationPing(HttpServletRequest request, UUID userId, int pingCount) {
        int limit = properties.getLocationPingRateLimitPerMinute();
        hit("locping:user:" + userId, limit, 1);
        hit("locping:ip:" + clientIp(request), Math.max(limit * 100, limit), 1);
    }

    private void maybeCleanup(long now, long cutoff) {
        if (now - lastCleanup < 300_000_000_000L) {
            return;
        }
        lastCleanup = now;
        Iterator<Map.Entry<String, Deque<Long>>> iterator = events.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, Deque<Long>> entry = iterator.next();
            Deque<Long> bucket = entry.getValue();
            synchronized (bucket) {
                if (bucket.isEmpty() || bucket.peekLast() <= cutoff) {
                    iterator.remove();
                }
            }
        }
    }
}
