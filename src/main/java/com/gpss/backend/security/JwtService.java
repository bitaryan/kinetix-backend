package com.gpss.backend.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.Security;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import java.util.HexFormat;
import java.util.UUID;

import javax.crypto.SecretKey;

import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.common.api.ApiException;
import com.gpss.backend.config.AppProperties;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;

@Service
public class JwtService {

    private final AppProperties properties;
    private final PasswordEncoder passwordEncoder;
    private final String dummyHash;
    private final SecureRandom secureRandom = new SecureRandom();

    public JwtService(AppProperties properties) {
        if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null) {
            Security.addProvider(new BouncyCastleProvider());
        }
        this.properties = properties;
        this.passwordEncoder = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8();
        this.dummyHash = this.passwordEncoder.encode("not-a-real-password");
    }

    public String hashPassword(String raw) {
        return passwordEncoder.encode(raw);
    }

    public boolean verifyPassword(String raw, String hash) {
        return passwordEncoder.matches(raw, hash);
    }

    public void verifyDummyPassword(String raw) {
        passwordEncoder.matches(raw, dummyHash);
    }

    public String createAccessToken(UUID userId, UUID sessionId, UserRole role) {
        Instant now = Instant.now();
        Instant exp = now.plusSeconds(properties.accessTokenExpireSeconds());
        return Jwts.builder()
                .subject(userId.toString())
                .claim("sid", sessionId.toString())
                .claim("role", role.name())
                .issuer(properties.getJwt().getIssuer())
                .audience().add(properties.getJwt().getAudience()).and()
                .issuedAt(Date.from(now))
                .notBefore(Date.from(now))
                .expiration(Date.from(exp))
                .signWith(signingKey())
                .compact();
    }

    public AccessTokenClaims decodeAccessToken(String token) {
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(signingKey())
                    .requireIssuer(properties.getJwt().getIssuer())
                    .requireAudience(properties.getJwt().getAudience())
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
            return new AccessTokenClaims(
                    UUID.fromString(claims.getSubject()),
                    UUID.fromString(claims.get("sid", String.class)),
                    UserRole.valueOf(claims.get("role", String.class)));
        } catch (JwtException | IllegalArgumentException | NullPointerException ex) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "Invalid or expired access token");
        }
    }

    public String generateRefreshToken() {
        byte[] bytes = new byte[48];
        secureRandom.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    public String hashRefreshToken(String token) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private SecretKey signingKey() {
        return Keys.hmacShaKeyFor(properties.getJwt().getSecretKey().getBytes(StandardCharsets.UTF_8));
    }

    public record AccessTokenClaims(UUID userId, UUID sessionId, UserRole role) {}
}
