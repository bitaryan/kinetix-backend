package com.gpss.backend.common.api;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.ALWAYS)
public record ApiListResponse<T>(boolean success, T data, Object meta, ApiError error) {

    public static <T> ApiListResponse<T> ok(T data, Object meta) {
        return new ApiListResponse<>(true, data, meta, null);
    }
}
