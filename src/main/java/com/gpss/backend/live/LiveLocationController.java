package com.gpss.backend.live;

import java.util.List;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.common.api.ApiResponse;
import com.gpss.backend.live.LiveLocationHub.LiveLocationDto;
import com.gpss.backend.security.CurrentPrincipal;

@RestController
@RequestMapping("/api/v1/admin")
public class LiveLocationController {

    private final LiveLocationHub hub;

    public LiveLocationController(LiveLocationHub hub) {
        this.hub = hub;
    }

    @GetMapping("/live-locations")
    public ApiResponse<List<LiveLocationDto>> liveLocations() {
        CurrentPrincipal.require().requireRoles(UserRole.ADMIN, UserRole.MANAGER);
        return ApiResponse.ok(hub.snapshot());
    }
}
