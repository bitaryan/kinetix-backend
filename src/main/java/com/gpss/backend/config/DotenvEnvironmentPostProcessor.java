package com.gpss.backend.config;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.util.StringUtils;

/**
 * Loads optional {@code .env} and rewrites Python-style {@code DATABASE_URL}
 * ({@code postgresql+asyncpg://}) into a JDBC URL.
 */
public class DotenvEnvironmentPostProcessor implements EnvironmentPostProcessor {

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        Map<String, Object> extras = new LinkedHashMap<>();
        Path dotenv = Path.of(".env");
        if (Files.isRegularFile(dotenv)) {
            try {
                for (String line : Files.readAllLines(dotenv)) {
                    String trimmed = line.strip();
                    if (trimmed.isEmpty() || trimmed.startsWith("#") || !trimmed.contains("=")) {
                        continue;
                    }
                    int eq = trimmed.indexOf('=');
                    String key = trimmed.substring(0, eq).strip();
                    String value = trimmed.substring(eq + 1).strip();
                    if ((value.startsWith("\"") && value.endsWith("\""))
                            || (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.substring(1, value.length() - 1);
                    }
                    extras.put(key, value);
                }
            } catch (IOException ignored) {
                // Optional file; Spring will still bind process environment variables.
            }
        }

        String rawUrl = firstNonBlank(
                asString(extras.get("DATABASE_URL")),
                environment.getProperty("DATABASE_URL"),
                environment.getProperty("spring.datasource.url"));
        if (StringUtils.hasText(rawUrl)) {
            extras.put("gpss.database-url", rawUrl);
            extras.put("spring.datasource.url", toJdbcUrl(rawUrl));
            ParsedUserPass userPass = parseUserPass(rawUrl);
            if (userPass != null) {
                extras.putIfAbsent("spring.datasource.username", userPass.user);
                extras.putIfAbsent("spring.datasource.password", userPass.password);
            }
        }

        if (!extras.isEmpty()) {
            environment.getPropertySources()
                    .addAfter(
                            StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                            new MapPropertySource("gpssDotenv", extras));
        }
    }

    static String toJdbcUrl(String raw) {
        String url = raw;
        if (url.startsWith("postgresql+asyncpg://")) {
            url = "postgresql://" + url.substring("postgresql+asyncpg://".length());
        }
        if (url.startsWith("postgresql://")) {
            url = "jdbc:" + url;
        }
        return stripUserInfo(url);
    }

    private static String stripUserInfo(String jdbcUrl) {
        int scheme = jdbcUrl.indexOf("://");
        if (scheme < 0) {
            return jdbcUrl;
        }
        String prefix = jdbcUrl.substring(0, scheme + 3);
        String rest = jdbcUrl.substring(scheme + 3);
        int at = rest.lastIndexOf('@');
        if (at < 0) {
            return jdbcUrl;
        }
        return prefix + rest.substring(at + 1);
    }

    private static ParsedUserPass parseUserPass(String raw) {
        String working = raw;
        if (working.startsWith("jdbc:")) {
            working = working.substring(5);
        }
        if (working.startsWith("postgresql+asyncpg://")) {
            working = working.substring("postgresql+asyncpg://".length());
        } else if (working.startsWith("postgresql://")) {
            working = working.substring("postgresql://".length());
        } else {
            return null;
        }
        int at = working.lastIndexOf('@');
        if (at < 0) {
            return null;
        }
        String userInfo = working.substring(0, at);
        int colon = userInfo.indexOf(':');
        if (colon < 0) {
            return new ParsedUserPass(userInfo, "");
        }
        return new ParsedUserPass(userInfo.substring(0, colon), userInfo.substring(colon + 1));
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (StringUtils.hasText(value)) {
                return value;
            }
        }
        return null;
    }

    private static String asString(Object value) {
        return value == null ? null : value.toString();
    }

    private record ParsedUserPass(String user, String password) {}
}
