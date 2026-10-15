# Dedicated PostgreSQL schema

This path is separate from the default SQLite schema and migration history.
It is derived from the complete fork schema, not `upstream/pg`. Only datasource,
client output and PostgreSQL native timestamp representation differ. Timestamp
values use `TIMESTAMPTZ(3)` to preserve millisecond instants independent of session
timezone; unsupported source precision must be rejected by the future importer.

Both providers now include `personal_mcp_grants` and `personal_mcp_contexts` in
`server/prisma/schema.prisma`, for 40 models total. Derive the PostgreSQL schema
directly from that canonical schema. The preservation migration retains the
same existing tables. `live-schema-extension.prisma` and `source-migrations/`
record the earlier live inspection and must not be applied again alongside the
canonical SQLite migrations. See the live-inspection runbook for that history.

From the repository root:

```bash
node scripts/database/postgresql-schema.cjs --check
node --test scripts/database/tests/configuration.test.cjs scripts/database/tests/schema-parity.test.cjs scripts/database/tests/postgresql-baseline.test.cjs
```

The baseline test requires Docker, the already available pinned PostgreSQL image
from the provisioning manifest, installed Prisma 5.3.1 and a generated PG client.
It creates a uniquely named synthetic, loopback-only, tmpfs-backed container and
removes only that owned container afterward. It uses no production data or
credentials. Requested Docker/Prisma failures are test failures, not skips.

Generate the isolated client with `yarn prisma:generate:postgresql` from `server/`.
Use a synthetic `ANYTHINGLLM_DATABASE_URL` when generating locally. The generated
directory is ignored and the existing SQLite client is not overwritten. Prisma
CLI may load `.env`; verification runs it from an isolated temporary working
directory with a scrubbed environment. Do not use developer/production secrets
for local fixture commands.

The initial migration must run through the explicitly authorized migrator account
on a fresh approved target with the provisioned `anythingllm_app` role already
present. It revokes runtime writes on Prisma's ledger. These deployment-specific
grants intentionally fail if that role is absent; do not silently skip them.

`prisma:migrate:postgresql` is an explicit maintenance command, **not** a runtime
startup hook or authorization to migrate production. Existing runtime and Docker
default to SQLite. PG runtime/import/recovery have local fixture tests, but actual
R2, current live-baseline artifact rehearsal, enforcement and cutover are pending.
