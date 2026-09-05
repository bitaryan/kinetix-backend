# GPSS Backend

Node.js + Express + Prisma implementation of the GPSS field-workforce API. It
preserves the existing Spring/Python client contract: JWT access tokens, opaque
refresh-cookie rotation, attendance and GPS tracking, live manager locations,
client logs, leaves, and protected uploads.

## Requirements

- Node.js 22 LTS (`nvm use`; Node.js 20.19+ remains the minimum)
- PostgreSQL 16+
- Redis 7+ when running multiple API instances (optional for one instance)

## Local setup

```bash
docker compose up -d postgres
cp .env.example .env
# Replace JWT_SECRET_KEY with a unique random value.
npm ci
npm run db:generate
npm run db:migrate
npm run dev
```

The API listens on port `8080` by default after checking its dependencies and
upload storage. `GET /health` preserves the public database health check;
`GET /readyz` also checks optional Redis and draining state, and `GET /livez`
reports process liveness.

`Dockerfile` provides a non-root `runtime` image and a separate `migrate` image
containing the Prisma CLI. `docker-compose.production.yml` configures private
persistent uploads and a read-only runtime. See [the production runbook](docs/PRODUCTION.md)
for configuration, migration, verification, backups, and rollback.

Production requires HTTPS CORS origins, secure cookies, and a database URL with
`sslmode=require`. Startup enforces `sslaccept=strict`; configure your database
provider's certificate settings. Prisma does not support libpq
`sslmode=verify-ca` / `verify-full`; these values are rejected instead of silently
falling back to an unencrypted connection.

Create the first administrator interactively:

```bash
npm run create-admin
```

## Existing production database

The Prisma baseline describes the already-deployed Alembic/Flyway schema. It
does not rename or recreate existing tables and retains PostgreSQL enums, CHECK
constraints, and partial indexes.

For a database that already has the complete Java V1 + V2 schema, mark the
baseline as applied once, then deploy later migrations normally:

```bash
npm run db:baseline
npm run db:migrate
```

Only run `db:baseline` after verifying that V1 and V2 are present. Fresh empty
databases must use `npm run db:migrate` instead. Never use `prisma db push` or
`prisma migrate reset` against production.

## Tests

```bash
npm test
```

Database integration tests require an explicitly isolated URL whose database
name contains `test`; they never fall back to or wipe the development database:

```bash
TEST_DATABASE_URL=postgresql://gpss:gpss@localhost:5432/gpss_test \
  TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
  npm run test:integration
```

The integration command validates the explicit test URL, deploys migrations to
that database, compares the schema, and runs integration tests. It fails if the
database URL is absent or unsafe. Redis tests require an explicitly isolated
`TEST_REDIS_URL`; they use unique keys and never flush a database. `npm test`
includes all tests, skipping only integrations without their explicit URLs.
GitHub Actions verifies PostgreSQL 16, Redis 7, Node 22, and both Docker targets.

## Runtime notes

- Refresh cookies are HttpOnly and scoped to `/api/v1/auth`.
- Uploaded images must live on persistent storage configured by `UPLOAD_DIR`.
- `/uploads/**` must not be exposed through an unauthenticated static server.
- The live manager feed is STOMP over raw WebSocket at `/ws`, destination
  `/topic/live-locations`; REST snapshot is `GET /api/v1/admin/live-locations`.
- Set `REDIS_URL` and a shared `REDIS_KEY_PREFIX` to enable atomic distributed
  rate limits and WebSocket fan-out. A Redis outage fails rate-limited requests
  with 503 instead of silently bypassing limits. Without Redis, use one process.
- Multiple replicas must mount the same private POSIX upload filesystem. Separate
  local disks or separate per-host Docker volumes are not shared storage.
- Dashboard credentials are revalidated before event delivery and periodically
  while idle. Clients must refresh and reconnect on access-token expiry, then
  reload the REST snapshot. Browser WebSocket origins use the CORS allow-list.

## Contract documentation

- Frozen client contract: [`docs/JAVA_REWRITE.md`](docs/JAVA_REWRITE.md)
- Native GPS behavior: [`docs/GPS_CLIENT.md`](docs/GPS_CLIENT.md)
- Migration verification: [`docs/NODE_MIGRATION.md`](docs/NODE_MIGRATION.md)
- Production operations: [`docs/PRODUCTION.md`](docs/PRODUCTION.md)

`JAVA_REWRITE.md` retains its historical filename because deployed clients and
review material already refer to it; its HTTP/JSON/database rules remain the
language-neutral compatibility contract for this Node implementation.
