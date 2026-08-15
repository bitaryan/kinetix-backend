package com.gpss.backend.config;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.StringUtils;

import jakarta.annotation.PostConstruct;

@ConfigurationProperties(prefix = "gpss")
public class AppProperties {

    private String appName = "GPSS Backend";
    private String appEnv = "development";
    private String apiV1Prefix = "/api/v1";
    private final Jwt jwt = new Jwt();
    private final Cookie cookie = new Cookie();
    private String corsOrigins = "http://localhost:3000,http://localhost:5173";
    private int loginRateLimitPerMinute = 120;
    private int refreshRateLimitPerMinute = 300;
    private int locationPingRateLimitPerMinute = 120;
    private double locationPingMinIntervalSeconds = 5;
    private int locationPingMaxPerSession = 6000;
    private int locationPingBatchMax = 120;
    private double locationPingMaxAccuracyMeters = 100;
    private long liveStaleAfterSeconds = 120;
    private long liveOfflineAfterSeconds = 900;
    private String trustedProxyIps = "";
    private String uploadDir = "uploads";
    private long maxUploadBytes = 5 * 1024 * 1024;
    private String publicBaseUrl = "";
    private String databaseUrl = "";

    @PostConstruct
    public void validate() {
        if ("none".equalsIgnoreCase(cookie.sameSite) && !cookie.secure) {
            throw new IllegalStateException("COOKIE_SECURE must be true when COOKIE_SAMESITE is none");
        }
        String secret = jwt.secretKey == null ? "" : jwt.secretKey.strip();
        if (!StringUtils.hasText(secret) || secret.length() < 32) {
            throw new IllegalStateException("JWT_SECRET_KEY must be at least 32 characters");
        }
        String lower = secret.toLowerCase(Locale.ROOT);
        if (lower.equals("replace-with-a-64-character-random-secret") || lower.startsWith("replace-")) {
            throw new IllegalStateException("JWT_SECRET_KEY must not use a placeholder value");
        }
        if ("production".equalsIgnoreCase(appEnv)) {
            if (!cookie.secure) {
                throw new IllegalStateException("COOKIE_SECURE must be true when APP_ENV is production");
            }
            String db = databaseUrl == null ? "" : databaseUrl.toLowerCase(Locale.ROOT);
            if (!db.contains("sslmode=") && !db.contains("ssl=")) {
                throw new IllegalStateException(
                        "DATABASE_URL must enable TLS (ssl or sslmode) when APP_ENV is production");
            }
            List<String> origins = corsOriginList();
            if (origins.isEmpty()) {
                throw new IllegalStateException("BACKEND_CORS_ORIGINS must be set when APP_ENV is production");
            }
            for (String origin : origins) {
                if ("*".equals(origin)) {
                    throw new IllegalStateException("BACKEND_CORS_ORIGINS must not include * with cookies");
                }
                URI parsed = URI.create(origin);
                if (!"https".equalsIgnoreCase(parsed.getScheme())) {
                    throw new IllegalStateException(
                            "BACKEND_CORS_ORIGINS must use https when APP_ENV is production");
                }
                String host = parsed.getHost() == null ? "" : parsed.getHost().toLowerCase(Locale.ROOT);
                if (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1")) {
                    throw new IllegalStateException(
                            "BACKEND_CORS_ORIGINS must not use localhost in production");
                }
            }
        }
    }

    public List<String> corsOriginList() {
        return splitCsv(corsOrigins);
    }

    public List<String> trustedProxyIpList() {
        return splitCsv(trustedProxyIps);
    }

    public boolean docsEnabled() {
        return !"production".equalsIgnoreCase(appEnv);
    }

    public String refreshCookiePath() {
        return apiV1Prefix + "/auth";
    }

    public int accessTokenExpireSeconds() {
        return jwt.accessTokenExpireMinutes * 60;
    }

    public int refreshCookieMaxAgeSeconds() {
        return jwt.refreshTokenExpireDays * 24 * 60 * 60;
    }

    private static List<String> splitCsv(String value) {
        if (!StringUtils.hasText(value)) {
            return List.of();
        }
        return Arrays.stream(value.split(","))
                .map(String::strip)
                .map(item -> item.endsWith("/") ? item.substring(0, item.length() - 1) : item)
                .filter(StringUtils::hasText)
                .toList();
    }

    public String getAppName() {
        return appName;
    }

    public void setAppName(String appName) {
        this.appName = appName;
    }

    public String getAppEnv() {
        return appEnv;
    }

    public void setAppEnv(String appEnv) {
        this.appEnv = appEnv;
    }

    public String getApiV1Prefix() {
        return apiV1Prefix;
    }

    public void setApiV1Prefix(String apiV1Prefix) {
        this.apiV1Prefix = apiV1Prefix;
    }

    public Jwt getJwt() {
        return jwt;
    }

    public Cookie getCookie() {
        return cookie;
    }

    public String getCorsOrigins() {
        return corsOrigins;
    }

    public void setCorsOrigins(String corsOrigins) {
        this.corsOrigins = corsOrigins;
    }

    public int getLoginRateLimitPerMinute() {
        return loginRateLimitPerMinute;
    }

    public void setLoginRateLimitPerMinute(int loginRateLimitPerMinute) {
        this.loginRateLimitPerMinute = loginRateLimitPerMinute;
    }

    public int getRefreshRateLimitPerMinute() {
        return refreshRateLimitPerMinute;
    }

    public void setRefreshRateLimitPerMinute(int refreshRateLimitPerMinute) {
        this.refreshRateLimitPerMinute = refreshRateLimitPerMinute;
    }

    public int getLocationPingRateLimitPerMinute() {
        return locationPingRateLimitPerMinute;
    }

    public void setLocationPingRateLimitPerMinute(int locationPingRateLimitPerMinute) {
        this.locationPingRateLimitPerMinute = locationPingRateLimitPerMinute;
    }

    public double getLocationPingMinIntervalSeconds() {
        return locationPingMinIntervalSeconds;
    }

    public void setLocationPingMinIntervalSeconds(double locationPingMinIntervalSeconds) {
        this.locationPingMinIntervalSeconds = locationPingMinIntervalSeconds;
    }

    public int getLocationPingMaxPerSession() {
        return locationPingMaxPerSession;
    }

    public void setLocationPingMaxPerSession(int locationPingMaxPerSession) {
        this.locationPingMaxPerSession = locationPingMaxPerSession;
    }

    public int getLocationPingBatchMax() {
        return locationPingBatchMax;
    }

    public void setLocationPingBatchMax(int locationPingBatchMax) {
        this.locationPingBatchMax = locationPingBatchMax;
    }

    public double getLocationPingMaxAccuracyMeters() {
        return locationPingMaxAccuracyMeters;
    }

    public void setLocationPingMaxAccuracyMeters(double locationPingMaxAccuracyMeters) {
        this.locationPingMaxAccuracyMeters = locationPingMaxAccuracyMeters;
    }

    public long getLiveStaleAfterSeconds() {
        return liveStaleAfterSeconds;
    }

    public void setLiveStaleAfterSeconds(long liveStaleAfterSeconds) {
        this.liveStaleAfterSeconds = liveStaleAfterSeconds;
    }

    public long getLiveOfflineAfterSeconds() {
        return liveOfflineAfterSeconds;
    }

    public void setLiveOfflineAfterSeconds(long liveOfflineAfterSeconds) {
        this.liveOfflineAfterSeconds = liveOfflineAfterSeconds;
    }

    public String getTrustedProxyIps() {
        return trustedProxyIps;
    }

    public void setTrustedProxyIps(String trustedProxyIps) {
        this.trustedProxyIps = trustedProxyIps;
    }

    public String getUploadDir() {
        return uploadDir;
    }

    public void setUploadDir(String uploadDir) {
        this.uploadDir = uploadDir;
    }

    public long getMaxUploadBytes() {
        return maxUploadBytes;
    }

    public void setMaxUploadBytes(long maxUploadBytes) {
        this.maxUploadBytes = maxUploadBytes;
    }

    public String getPublicBaseUrl() {
        return publicBaseUrl;
    }

    public void setPublicBaseUrl(String publicBaseUrl) {
        this.publicBaseUrl = publicBaseUrl;
    }

    public String getDatabaseUrl() {
        return databaseUrl;
    }

    public void setDatabaseUrl(String databaseUrl) {
        this.databaseUrl = databaseUrl;
    }

    public static class Jwt {
        private String secretKey = "";
        private String algorithm = "HS256";
        private String issuer = "gpss-backend";
        private String audience = "gpss-client";
        private int accessTokenExpireMinutes = 15;
        private int refreshTokenExpireDays = 7;

        public String getSecretKey() {
            return secretKey;
        }

        public void setSecretKey(String secretKey) {
            this.secretKey = secretKey;
        }

        public String getAlgorithm() {
            return algorithm;
        }

        public void setAlgorithm(String algorithm) {
            this.algorithm = algorithm;
        }

        public String getIssuer() {
            return issuer;
        }

        public void setIssuer(String issuer) {
            this.issuer = issuer;
        }

        public String getAudience() {
            return audience;
        }

        public void setAudience(String audience) {
            this.audience = audience;
        }

        public int getAccessTokenExpireMinutes() {
            return accessTokenExpireMinutes;
        }

        public void setAccessTokenExpireMinutes(int accessTokenExpireMinutes) {
            this.accessTokenExpireMinutes = accessTokenExpireMinutes;
        }

        public int getRefreshTokenExpireDays() {
            return refreshTokenExpireDays;
        }

        public void setRefreshTokenExpireDays(int refreshTokenExpireDays) {
            this.refreshTokenExpireDays = refreshTokenExpireDays;
        }
    }

    public static class Cookie {
        private boolean secure;
        private String sameSite = "strict";

        public boolean isSecure() {
            return secure;
        }

        public void setSecure(boolean secure) {
            this.secure = secure;
        }

        public String getSameSite() {
            return sameSite;
        }

        public void setSameSite(String sameSite) {
            this.sameSite = sameSite;
        }
    }
}
