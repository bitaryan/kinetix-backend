# Production deployment

The release target is Node.js 22, PostgreSQL 16, persistent private uploads, and
an HTTPS reverse proxy. `docker-compose.production.yml` runs one API instance
against an externally configured database. It does not provision a database,
configure DNS/TLS, publish images, or run migrations automatically at startup.

## Release verification

Install Node 22 (`nvm use` reads `.nvmrc`), then run:

```bash
npm ci
npm run build
npm test
npm run test:integration
npm audit --omit=dev --audit-level=high
```

Before `test:integration`, explicitly set `TEST_DATABASE_URL` to a disposable
PostgreSQL database whose name contains `test`. It must never identify the
development or production database. Set `TEST_REDIS_URL` to an isolated Redis
test instance to exercise the shared adapters. The integration runner fails
when the database URL is missing or unsafe, applies checked-in migrations using
`migrate deploy`, verifies the Prisma model, then runs the database tests. It
never runs `db push`, resets a database, or falls back to `DATABASE_URL`.

Tests create unique fixtures and remove their own records afterward. The API
flow temporarily changes the location-mode singleton and restores it. Run one
integration suite at a time against a dedicated test database.

`npm run db:verify` performs a read-only model comparison against
`TEST_DATABASE_URL`. Prisma does not represent CHECK constraints or partial
indexes in its model; the integration suite separately verifies the leave date
CHECK, single active attendance constraint, GPS event uniqueness, and native
enum values using actual database writes. These fixtures are also removed.

GitHub Actions performs these checks with disposable PostgreSQL 16 and Redis 7
services, builds both Docker targets, runs the migration image, and smoke-tests
the serving image with its read-only filesystem and readiness health check. A
local successful test run does not establish that CI or a Docker build passed;
check the actual job before releasing.

## Configuration and storage

Create `.env.production` outside version control using your deployment's secret
manager. Docker excludes `.env*` from image builds. Supply:

- `DATABASE_URL`: the production PostgreSQL connection with `sslmode=require`
  and `sslaccept=strict`, plus the certificate settings required by the provider.
  Prisma's supported TLS parameters apply; do not use libpq `verify-*` modes.
- `JWT_SECRET_KEY`: a unique random secret of at least 32 characters. Preserve
  the existing value, issuer and audience during migration to keep valid access
  tokens usable. Changing these values logs users out.
- `BACKEND_CORS_ORIGINS`: the exact HTTPS browser origins, comma-separated;
  exclude localhost and wildcards.
- `COOKIE_SAMESITE`: preserve the current deployed value (`strict` by default).
  The template forces `COOKIE_SECURE=true` and `APP_ENV=production`.
- `TRUSTED_PROXY_IPS`: only the actual, exact proxy IP addresses (CIDR ranges
  are not accepted). The proxy must overwrite forwarded client-IP headers and prevent
  direct access to the backend.
- `PUBLIC_BASE_URL`: the public HTTPS API origin if clients require absolute
  protected image URLs; otherwise leave it empty for relative URLs.
- `DB_POOL_SIZE` and `DB_POOL_TIMEOUT_SECONDS`: size per-process pools within the
  database's connection budget, including migrations and administrative access.
- Optional `REDIS_URL` and `REDIS_KEY_PREFIX`: a TLS Redis connection (`rediss://`
  in production), credentials from the secret manager, and a unique prefix per
  environment. API instances in the same environment must share both values.
- `REDIS_COMMAND_TIMEOUT_MS`: bounds Redis connection/command waits (5000ms by
  default). Redis is required for readiness when configured; unavailable rate
  limiting returns 503. `SHUTDOWN_TIMEOUT_MS` controls HTTP draining (30000ms);
  keep the orchestrator's grace period at least 5 seconds longer.

The template binds only `127.0.0.1:8080` on the host; a host reverse proxy can
reach it. A proxy running in another container needs an explicitly configured
private Docker network instead. Set `GPSS_HTTP_PORT` if a different host port is
needed. The container still listens internally on 8080.

Uploads use a persistent named volume mounted at `/app/uploads`, owned by the
container's non-root user. For an existing bind mount, arrange owner/group
permissions for UID/GID 1000 before startup. Never publish this directory through
Nginx, a CDN, or a public bucket: `/uploads/**` must pass through API
authentication and real-path containment checks. Include uploads in backups.

## Schema migration and rollout

1. Record the release identifier and current image. Take a restorable database
   backup and a matching upload backup. Verify restoration in an isolated
   environment before the first production cutover.
2. For a fresh empty database, deploy migrations normally. For an existing
   Alembic/Flyway database, verify the complete V1 and V2 schema first. Compare
   the restored database to the Prisma model and check the custom constraints
   and indexes through the integration tests. Baseline only after this succeeds.
3. Export `GPSS_IMAGE_TAG` with the immutable release identifier, then build:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml build api migrate
   ```

4. On a verified existing installation only, mark the baseline once:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml run --rm migrate node scripts/prisma-cli.js migrate resolve --applied 20260816000000_existing_schema
   ```

   Baseline marks migration history; it does not add missing tables, columns,
   constraints or indexes. Fresh databases must skip this command.
5. Run one migration job and wait for its successful completion:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml run --rm migrate
   ```

6. Start the API, wait for readiness, and check its logs:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml up -d --no-deps api
   docker compose --env-file .env.production -f docker-compose.production.yml ps
   docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=100 api
   curl --fail http://127.0.0.1:8080/readyz
   ```

7. Create the first administrator if needed:

   ```bash
   docker compose --env-file .env.production -f docker-compose.production.yml exec api npm run create-admin
   ```

   The prompt accepts the password interactively. Do not put it in shell history
   or container arguments. For an existing deployment, use the existing admin.
8. Through the public HTTPS origin, verify login/refresh/logout, a protected
   upload, and a manager's STOMP connection. Check cookie path, Secure, HttpOnly,
   SameSite, the browser origin allow-list, and the client's existing JSON keys.

## Proxy, health and shutdown

Forward ordinary API traffic and WebSocket upgrades for `/ws` to the API. The
dashboard uses STOMP over raw WebSocket at `/topic/live-locations`; phones send
authenticated HTTP GPS requests. The proxy must support `Upgrade` and
`Connection` forwarding and allow idle times compatible with the dashboard's
heartbeat/reconnect behavior. Preserve the configured API path and cookies.

Set a request-body limit large enough for two attendance images (each up to
`MAX_UPLOAD_BYTES`) plus multipart overhead. A proxy that rejects requests first
may emit its own 413 page instead of the API's image error envelope; configure
limits intentionally and test with deployed clients. Use bounded upstream
timeouts and TLS on the public listener.

`/livez` reports process liveness. `/readyz` checks database access, optional
Redis availability, and shutdown state; use it for traffic routing and the
container health check. The frozen `/health` endpoint remains the database
check used by existing clients. A dependency outage should remove an instance
from traffic without an endless liveness restart cycle.

The API drains on SIGTERM/SIGINT and bounds shutdown at 30 seconds. The Compose
stop grace period is 35 seconds. Clients must reconnect their WebSocket and retry
queued GPS samples with the same `clientEventId` after a restart. Container health
status is diagnostic: Docker Compose does not automatically restart an unhealthy
running container just because of its health status.

## Operations, recovery and scaling

Monitor readiness failures, HTTP 5xx and latency, login/GPS 429 rates, database
connections, disk space/inodes in uploads, Redis memory/connectivity, and process
restarts. Send stdout/stderr to restricted central logs with retention limits;
do not add request bodies, Authorization headers, refresh cookies, or credentials
to proxy logs.

Back up PostgreSQL using the provider's backups/PITR or `pg_dump --format=custom`
with credentials delivered through a protected password file. Back up uploads
as well, and keep their recovery point consistent with the database. Practice
restoring both into an isolated environment and measure recovery time. Set
retention requirements for attendance, location history, files and sessions with
the business before introducing deletion jobs.

To roll back an application-only release, select the previous image tag and
restart the API after confirming that it understands the current schema. Do not
run a migration reset or drop production tables. For incompatible schema changes,
use a reviewed forward fix or a coordinated database/upload restore; restoring
can discard writes after the backup. Preserve the upload volume across releases;
`docker compose down --volumes` would destroy it and must not be used in a normal
release or rollback.

Without Redis, keep a single API process because limits and live events are
process-local. For multiple replicas, configure shared Redis and mount the same
private POSIX upload filesystem on every replica. Separate local volumes do not
provide shared storage; a named Docker volume alone only solves persistence on
one host. Account for every replica's database pool and validate Redis failures,
cross-instance rate limiting, GPS fan-out, and upload retrieval before scaling.

Redis 7+ standalone servers and managed single-endpoint deployments are supported;
Redis Cluster requires a cluster-aware adapter and is not enabled by this URL
configuration. Use verified `rediss://` TLS in production and the platform trust
store (or `NODE_EXTRA_CA_CERTS` for your private CA). Grant only the Redis commands
needed for connection setup, `EVAL`, `TIME`, sorted sets/expiry, `PING`, and pub/sub
on the environment prefix. Pub/sub channels are not isolated by Redis database
number, so distinct environments must use distinct `REDIS_KEY_PREFIX` values.

The client disables offline command queuing and bounds pending commands so a
Redis outage cannot accumulate unlimited work. See the official
[Node Redis production guidance](https://redis.io/docs/latest/develop/clients/nodejs/produsage/)
and [pub/sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/).

## Local release verification — 5 September 2026

The completed backend was verified locally with Node.js 22.23.2, PostgreSQL
16.14, and Redis 7.4.11 using isolated test services:

- All 85 tests passed, with no failures or skipped tests, including database
  concurrency, GPS backfill/idempotency, Redis coordination, and WebSocket
  authorization regressions.
- The build and Prisma client generation succeeded. The integration runner
  applied the baseline on a fresh test database and reported no Prisma schema
  drift; database tests also checked the custom constraints and indexes.
- Both runtime and migration Docker images built successfully. The migration
  image ran with a read-only filesystem; the non-root, read-only API container
  passed its health probes and denied unauthenticated protected requests.
- During a real Redis outage, readiness and Redis-backed login limiting returned
  503 while the existing database-only health endpoint remained available.
  Readiness recovered automatically after Redis restarted.
- SIGTERM shut down the API container cleanly with exit code 0. Dependency audits
  reported zero known vulnerabilities at verification time.

These are local verification results, not a production deployment or a remote CI
run. Before release, run the committed CI workflow, provision production secrets,
verified TLS, the HTTPS proxy and persistent storage, and complete the deployed
client smoke checks above. Load/capacity testing and backup-restore drills remain
specific to the chosen production infrastructure.
