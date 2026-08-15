package com.gpss.backend.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class AppPropertiesTest {

    @Test
    void placeholderSecretRejected() {
        AppProperties props = valid();
        props.getJwt().setSecretKey("replace-with-a-64-character-random-secret");
        assertThatThrownBy(props::validate).hasMessageContaining("placeholder");
    }

    @Test
    void productionRequiresHttpsCorsAndTls() {
        AppProperties props = valid();
        props.setAppEnv("production");
        props.getCookie().setSecure(false);
        assertThatThrownBy(props::validate).hasMessageContaining("COOKIE_SECURE");

        props.getCookie().setSecure(true);
        props.setCorsOrigins("http://app.example.com");
        props.setDatabaseUrl("jdbc:postgresql://db/gpss?sslmode=require");
        assertThatThrownBy(props::validate).hasMessageContaining("https");

        props.setCorsOrigins("https://localhost:3000");
        assertThatThrownBy(props::validate).hasMessageContaining("localhost");

        props.setCorsOrigins("https://app.example.com");
        props.validate();
        assertThat(props.getCookie().isSecure()).isTrue();
    }

    private static AppProperties valid() {
        AppProperties props = new AppProperties();
        props.getJwt().setSecretKey("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        props.setDatabaseUrl("jdbc:postgresql://localhost:5432/gpss?sslmode=require");
        return props;
    }
}
