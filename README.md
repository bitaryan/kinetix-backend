# GPSS Backend

Java 21 + Spring Boot 3.3 field-workforce API (punch, GPS trail, leaves, client logs).

## Run

```bash
docker compose up -d postgres
cp .env.example .env   # set JWT_SECRET_KEY (min 32 chars, not a replace- placeholder)
./gradlew bootRun
```

Create the first admin:

```bash
./gradlew bootRun --args='--create-admin'
```

## Tests

```bash
./gradlew test
```

Uses Testcontainers PostgreSQL 16 when Docker is available; otherwise `localhost:5432/gpss`.

## Docs

- Frozen HTTP contract: [`docs/JAVA_REWRITE.md`](docs/JAVA_REWRITE.md)
- Native GPS: [`docs/GPS_CLIENT.md`](docs/GPS_CLIENT.md)
