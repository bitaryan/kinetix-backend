package com.gpss.backend.live;

import java.time.Instant;
import java.util.List;

import org.springframework.http.HttpStatus;
import org.springframework.lang.NonNull;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Component;

import com.gpss.backend.auth.domain.ActiveSession;
import com.gpss.backend.auth.domain.User;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.auth.infra.ActiveSessionRepository;
import com.gpss.backend.auth.infra.UserRepository;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.security.CurrentPrincipal;
import com.gpss.backend.security.JwtService;

@Component
public class LiveLocationChannelInterceptor implements ChannelInterceptor {

    private final JwtService jwtService;
    private final ActiveSessionRepository sessions;
    private final UserRepository users;

    public LiveLocationChannelInterceptor(
            JwtService jwtService, ActiveSessionRepository sessions, UserRepository users) {
        this.jwtService = jwtService;
        this.sessions = sessions;
        this.users = users;
    }

    @Override
    public Message<?> preSend(@NonNull Message<?> message, @NonNull MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null || accessor.getCommand() != StompCommand.CONNECT) {
            return message;
        }
        String auth = accessor.getFirstNativeHeader("Authorization");
        if (auth == null || !auth.regionMatches(true, 0, "Bearer ", 0, 7)) {
            throw new ApiException(401, "UNAUTHORIZED", "A bearer access token is required");
        }
        JwtService.AccessTokenClaims claims = jwtService.decodeAccessToken(auth.substring(7).strip());
        ActiveSession session = sessions.findById(claims.sessionId()).orElse(null);
        if (session == null
                || session.isRevoked()
                || !session.getExpiresAt().isAfter(Instant.now())
                || !session.getUserId().equals(claims.userId())) {
            throw new ApiException(401, "UNAUTHORIZED", "Access session is no longer active");
        }
        User user = users.findById(claims.userId()).orElse(null);
        if (user == null || !user.isActive()) {
            throw new ApiException(401, "UNAUTHORIZED", "User account is unavailable");
        }
        if (user.getRole() != UserRole.ADMIN && user.getRole() != UserRole.MANAGER) {
            throw new ApiException(403, "FORBIDDEN", "You do not have permission for this action");
        }
        CurrentPrincipal principal = new CurrentPrincipal(user, session.getId());
        accessor.setUser(new UsernamePasswordAuthenticationToken(
                principal, null, List.of(new SimpleGrantedAuthority("ROLE_" + user.getRole().name()))));
        return message;
    }
}
