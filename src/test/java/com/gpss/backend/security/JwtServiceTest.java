package com.gpss.backend.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.config.AppProperties;
import com.gpss.backend.security.JwtService.AccessTokenClaims;

class JwtServiceTest {

    @Test
    void signsAndRejectsTamper() {
        AppProperties props = new AppProperties();
        props.getJwt().setSecretKey("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        JwtService jwt = new JwtService(props);
        UUID user = UUID.randomUUID();
        UUID session = UUID.randomUUID();
        String token = jwt.createAccessToken(user, session, UserRole.MANAGER);
        AccessTokenClaims claims = jwt.decodeAccessToken(token);
        assertThat(claims.userId()).isEqualTo(user);
        assertThat(claims.sessionId()).isEqualTo(session);
        assertThat(claims.role()).isEqualTo(UserRole.MANAGER);
        org.junit.jupiter.api.Assertions.assertThrows(
                com.gpss.backend.common.api.ApiException.class, () -> jwt.decodeAccessToken(token + "corrupted"));
    }
}
