package com.gpss.backend.leave.web;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.leave.domain.LeaveStatus;

public final class LeaveDates {

    private static final Pattern SHORT = Pattern.compile("^(\\d{2})/(\\d{2})/(\\d{2})$");
    private static final Pattern FULL = Pattern.compile("^(\\d{2})/(\\d{2})/(\\d{4})$");
    private static final DateTimeFormatter OUT = DateTimeFormatter.ofPattern("dd/MM/yy", Locale.UK);

    private LeaveDates() {}

    public static String format(LocalDate value) {
        return value.format(OUT);
    }

    public static String titleCase(LeaveStatus status) {
        String raw = status.name().toLowerCase(Locale.ROOT);
        return Character.toUpperCase(raw.charAt(0)) + raw.substring(1);
    }

    public static LocalDate parse(String value) {
        String raw = value.strip();
        Matcher shortMatch = SHORT.matcher(raw);
        if (shortMatch.matches()) {
            return of(
                    Integer.parseInt(shortMatch.group(3)) + 2000,
                    Integer.parseInt(shortMatch.group(2)),
                    Integer.parseInt(shortMatch.group(1)));
        }
        Matcher full = FULL.matcher(raw);
        if (full.matches()) {
            return of(
                    Integer.parseInt(full.group(3)),
                    Integer.parseInt(full.group(2)),
                    Integer.parseInt(full.group(1)));
        }
        try {
            return LocalDate.parse(raw);
        } catch (Exception ex) {
            throw new ApiException(422, "VALIDATION_ERROR", "Select a valid date");
        }
    }

    private static LocalDate of(int year, int month, int day) {
        try {
            return LocalDate.of(year, month, day);
        } catch (DateTimeException ex) {
            throw new ApiException(422, "VALIDATION_ERROR", "Select a valid date");
        }
    }
}
