# GPSS Backend (Java)

Spring Boot 3.3 rewrite of the FastAPI API. Python under `app/` remains the behavioral oracle until cutover.

## Run

```bash
./gradlew bootRun
```

Uses `.env` / `DATABASE_URL` (including `postgresql+asyncpg://`) and `JWT_SECRET_KEY`. Create the first admin:

```bash
./gradlew bootRun --args='--create-admin'
```

## Tests

```bash
./gradlew test
```

Uses Testcontainers PostgreSQL 16 when Docker is available; otherwise `localhost:5432/gpss` (same as the Python suite).

## Docs

- Frozen HTTP contract: `docs/JAVA_REWRITE.md`
- Native GPS: `docs/GPS_CLIENT.md`
- Intentional Python deltas: `docs/JAVA_VS_PYTHON.md`
