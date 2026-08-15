package com.gpss.backend.common.time;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;

public final class InstantParse {

    private InstantParse() {}

    public static Instant requireOffset(String raw) {
        Instant parsed = tryParseAware(raw);
        if (parsed == null) {
            throw new com.gpss.backend.common.api.ApiException(
                    422, "VALIDATION_ERROR", "capturedAt must include a timezone offset");
        }
        return parsed;
    }

    public static Instant tryParseAware(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String value = raw.strip();
        try {
            if (value.endsWith("Z")) {
                return Instant.parse(value);
            }
            return OffsetDateTime.parse(value).toInstant();
        } catch (DateTimeParseException ignored) {
            try {
                LocalDateTime.parse(value);
                return null;
            } catch (DateTimeParseException ex) {
                return null;
            }
        }
    }

    public static boolean isNaive(String raw) {
        if (raw == null || raw.isBlank()) {
            return true;
        }
        try {
            if (raw.endsWith("Z") || raw.contains("+") || offsetAfterT(raw)) {
                Instant.parse(raw.endsWith("Z") ? raw : OffsetDateTime.parse(raw).toInstant().toString());
                return false;
            }
            LocalDateTime.parse(raw.strip());
            return true;
        } catch (Exception ex) {
            return tryParseAware(raw) == null;
        }
    }

    private static boolean offsetAfterT(String raw) {
        int t = raw.indexOf('T');
        if (t < 0) {
            return false;
        }
        String rest = raw.substring(t);
        return rest.contains("+") || rest.contains("-") && rest.lastIndexOf('-') > 2;
    }
}
