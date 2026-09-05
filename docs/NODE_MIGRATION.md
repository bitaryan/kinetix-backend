# Node.js migration notes

The active backend is JavaScript ESM with Express 5 and Prisma. Authentication,
attendance/GPS, live locations, leave, client logs, protected uploads, health,
and administrator bootstrap have all moved to `src/`. Java and Gradle sources
were removed from the working tree; their previous versions remain in Git.

## Database cutover

- Existing table/column names, PostgreSQL enum values, foreign keys, leave date
  CHECK constraint, and partial unique indexes are retained.
- A database containing the full original V1 and V2 schema must be verified and
  then baselined with `npm run db:baseline`. Use `npm run db:migrate` for a fresh
  empty database. Do not reset or recreate an existing environment.
- No normal development or production database was changed during this
  migration. Verification used separate temporary PostgreSQL databases.
- The original `.env` and existing uploaded files were left untouched.
- Existing Argon2 PHC passwords and active-session token hashes remain usable.
  Keep the same JWT secret, issuer, audience, and cookie configuration during
  cutover. Legacy JDBC and asyncpg URL schemes are normalized for Prisma.
- Production TLS configuration must use Prisma-supported parameters; see the
  README. Unsupported `sslmode=verify-*` values fail startup rather than silently
  permitting plaintext.

## Verification

The automated suite covers HTTP envelopes/cookies, authentication and lockout,
refresh reuse, current database roles, leave rules, client-log search and images,
upload containment, GPS idempotency, concurrent punch-out cleanup, transaction
retries, timestamp validation, and raw WebSocket/STOMP protocol safety.

The full HTTP flow was exercised against an isolated PostgreSQL database. The
Prisma model was also compared with both a fresh Prisma migration and the original
Java V1 + V2 migrations. Both schema comparisons produced an empty diff; partial
indexes and the leave CHECK constraint were checked separately. Server startup,
database health, and graceful shutdown were smoke-tested.

The September 2026 completion adds regression tests and an explicit integration
runner that applies migrations only to an isolated `TEST_DATABASE_URL`, compares
the Prisma model, and tests native enums, CHECK constraints and partial unique
indexes separately. Tests remove only their own fixture records. The GitHub
Actions workflow runs these checks with Node 22, PostgreSQL 16 and Redis 7, audits
production dependencies, and builds/smoke-tests release images.

## Completed GPS and production work

- Older queued in-shift samples now use neighboring timestamps for throttling,
  including after punch-out. Historical inserts and older punch-out GPS no
  longer move `last_known_*` backward. Freshness/accuracy/capacity rules remain.
- Single-location batches check duplicate IDs consistently with single pings.
- Optional Redis provides atomic shared rate limiting and cross-instance live
  events. Redis failures never silently fall back to independent limits.
- WebSocket sessions check current authorization before updates and periodically
  while idle, bound pending authentication/output, and validate browser origins.
- Input lengths, numeric ranges, multipart limits, image MIME/magic agreement,
  protected image caching, proxy handling, and terminal password entry are hardened.
- Startup verifies dependencies/storage; separate readiness and liveness probes,
  bounded shutdown, a migration image, and a production Compose template are added.

See [PRODUCTION.md](PRODUCTION.md) for actual release gates and environment setup.
Optional multi-replica deployments must mount the same private upload filesystem
on every instance. Redis pub/sub is transient; dashboards reload the REST snapshot
after reconnecting. No production database is modified by these verification steps.
