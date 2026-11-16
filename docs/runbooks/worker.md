# Worker runbook

The settlement worker (`apps/worker`) is the always-on service that will run
settlement, invite expiry and the slot sweepers on pg-boss, per ADR-0003 D5.
ADR-0005 records why it is shaped the way it is.

It is a plain Node process under `tsx`: no compile step, no HTTP server, no
listening port. Its output is JSON lines on stdout and stderr, and the platform
supervises it.

**Current scope.** The worker hosts pg-boss and a single `system.ping` queue. It
contains no business logic yet: no sweepers, no settlement, no expiry jobs. The
ping queue exists to prove the enqueue/consume round trip against the configured
schema, and it is not a business job.

## Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | - | Postgres connection string. Must be the Supabase **session pooler** (see below). Feeds both pg-boss and the shared Prisma client. |
| `PGBOSS_SCHEMA` | no | `pgboss` | Schema pg-boss owns and migrates. Must match `/^[a-z_][a-z0-9_]{0,62}$/`. |
| `PGBOSS_POOL_MAX` | no | `4` | Maximum pg-boss pool connections, 1 to 10. |
| `SHUTDOWN_TIMEOUT_MS` | no | `30000` | Graceful-stop budget in milliseconds, 1000 to 120000. |
| `LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |
| `NODE_ENV` | no | `development` | `production` removes error stacks from log lines. |

Numeric variables are parsed strictly: `4x`, `0x10`, `+4`, `-1` and ` 4` are
rejected rather than coerced. An empty variable is treated as unset, except for
`DATABASE_URL`, which is then reported as missing.

## `DATABASE_URL` must be the session pooler

Use the Supabase dashboard: **Connect** panel, **Session pooler**, port **5432**
on the pooler host.

Never use port **6543** (the transaction pooler) and never add `pgbouncer=true`.
pg-boss relies on session state and advisory locks, which transaction pooling
does not preserve; the failure is not a clean error under load, it is jobs that
stop being claimed. The worker refuses both forms at startup with exit code 2.

The direct connection is not the default either: it is IPv6-only unless the
project has Supabase's IPv4 add-on.

## Running it locally

PowerShell, from the repository root:

```powershell
$env:DATABASE_URL = "postgres://postgres:postgres@localhost:5432/socialbucks"
pnpm --filter worker start
```

Stop it with Ctrl+C (that is `SIGINT`, the same graceful path as `SIGTERM`).

Checks that need no database:

```powershell
pnpm --filter worker exec tsc --noEmit
pnpm --filter worker exec vitest run
```

Database tests (the pg-boss smoke test) need a local `*_test` database and an
explicit opt-in:

```powershell
$env:TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/socialbucks_test"
$env:DATABASE_URL = $env:TEST_DATABASE_URL
$env:RUN_DB_TESTS = "1"
pnpm --filter worker exec vitest run
```

The test database guard refuses to run unless every database variable points at
the same local database whose name ends in `_test`.

## Deploying on Railway

- **Root directory:** leave it at the repository root. The pnpm workspace and
  `pnpm-lock.yaml` live there, and `--filter worker` selects the app. Pointing
  the root directory at `apps/worker` breaks both commands below.
- **Install command:** `pnpm install --frozen-lockfile`
- **Start command:** `pnpm --filter worker start`
- **Restart policy:** restart on failure (always-on). The worker exits non-zero
  when it cannot start, and the platform is expected to bring it back.
- **Spend cap:** set a monthly spend cap on the project. The worker keeps a
  database connection open around the clock, so a crash loop costs real money.
- **Environment variables:** set `DATABASE_URL` (session pooler) only on the
  worker service, not on the web service and not as a shared project variable.
  The same rule applies to the token-decryption key and the YouTube client
  credentials once the worker reads them (ADR-0005 D6).

No release step is needed: the generated Prisma client is committed and `tsx`
runs the TypeScript sources directly. `turbo run build` and `turbo run lint`
skip this package because it declares no `build` or `lint` script.

## Graceful shutdown

On the first `SIGTERM` or `SIGINT` the worker:

1. logs `shutdown started`;
2. calls `pg-boss.stop({ graceful: true, timeout: SHUTDOWN_TIMEOUT_MS })`, which
   stops claiming jobs and lets running handlers finish;
3. disconnects the shared Prisma client;
4. logs `worker stopped` and exits **0**.

Guards around that path:

- A watchdog forces exit **1** if shutdown takes longer than
  `SHUTDOWN_TIMEOUT_MS` + 5000 ms, so a stuck handler cannot hold the platform's
  stop window open.
- A **second** signal during shutdown exits **1** immediately.
- `stop()` is idempotent: every call returns the same promise, so overlapping
  signals cannot double-stop pg-boss.

An `uncaughtException` or `unhandledRejection` is logged at error level and exits
**1**; the platform restarts the service.

## When it will not start

Configuration problems exit **2** with a single line on stderr and no stack, so
the reason is the whole message. The database password is never printed.

| Message | Fix |
|---|---|
| `DATABASE_URL is required` | The variable is missing or empty on the service. |
| `DATABASE_URL is not a valid URL` | It is not a `postgres://` or `postgresql://` URL; check for stray quotes or a truncated paste. |
| `DATABASE_URL uses port 6543 ...` | Replace it with the session pooler string (port 5432). |
| `DATABASE_URL sets pgbouncer=true ...` | Remove the parameter, or copy the session pooler string instead. |
| `PGBOSS_POOL_MAX must be a whole number between 1 and 10` | Fix the value; it is not coerced. |
| `SHUTDOWN_TIMEOUT_MS must be a whole number between 1000 and 120000` | Fix the value. |
| `LOG_LEVEL must be one of debug, info, warn, error` | Fix the value. |
| `PGBOSS_SCHEMA must match ...` | Use lowercase letters, digits and underscores, at most 63 characters. |

Anything else exits **1** and is logged as a JSON line. The usual causes:

- the database is unreachable from the host (session pooler host and port,
  network egress);
- the connecting role lacks `CREATE` on the database, so pg-boss cannot create
  its own schema on the first start;
- the role lacks privileges on an existing `PGBOSS_SCHEMA` from an earlier
  deployment;
- `NODE_ENV=production` and a library raised an error whose stack was stripped
  from the log line, so check the message and the pg-boss `error` event above it.

## Database startup and Prisma output

The worker builds its own Prisma client instead of using the shared singleton
(ADR-0006 D9). Two things follow:

- **Startup fails in about ten seconds, not twenty-three.** An unreachable or
  rejecting database now hits the client's 10 s connect timeout, exits **1**,
  and logs one JSON line whose fields are the error name and the Prisma code -
  never the message, host, user or connection string.
- **Prisma prints nothing of its own.** `prisma:error` blocks (which quote the
  database user and host:port) and `query` logs (SQL with parameters) are off,
  so nothing bypasses the worker's logger and its redaction.

If you need the reason a connection failed, use the error name and code from
the log line, and check the host and port in the platform's configuration -
they are deliberately not in the log.

## Privileges and secrets

From ADR-0005 D6:

- The worker holds the token-decryption key and the YouTube client credentials
  once it decrypts stored tokens and calls YouTube. They live only in the
  worker's environment, never in a shared file, and are never logged. The logger
  redacts any field whose key contains `pass`, `secret`, `token`,
  `authorization`, `cipher`, `key`, `url` or `cookie`, at every depth.
- The connecting role needs `CREATE` on the database so pg-boss can install and
  upgrade its schema. The worker issues no DDL outside its own `PGBOSS_SCHEMA`
  and never touches the application schema. "The worker never runs migrations"
  means exactly that.
- Recommended, not yet done: a dedicated database role for the worker with
  `UPDATE` on the slot tables, `INSERT` on the payout ledger, `SELECT` where
  needed, `CREATE` scoped to its own schema, and no `DELETE` or `TRUNCATE`
  anywhere. That also means a second connection string to manage, which is why
  it is deferred until the worker has real jobs.
