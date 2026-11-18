# Worker runbook

The settlement worker (`apps/worker`) is the always-on service that will run
settlement, invite expiry and the slot sweepers on pg-boss, per ADR-0003 D5.
ADR-0005 records why it is shaped the way it is.

It is a plain Node process under `tsx`: no compile step, no HTTP server, no
listening port. Its output is JSON lines on stdout and stderr, and the platform
supervises it.

**Current scope.** The worker runs invite expiry, the settlement sweep and its
per-slot settle job, and the window-close sweep and its per-slot close job
(ADR-0006). The job table below lists the queues, their schedules and what each
one writes. It is still a plain Node process: no HTTP server and no listening
port. All of its configuration is its own environment - the database and pg-boss
variables (`DATABASE_URL`, `PGBOSS_*`, `SHUTDOWN_TIMEOUT_MS`, `LOG_LEVEL`,
`NODE_ENV`) and the settlement credentials (`YOUTUBE_*`, `INSTAGRAM_*`) - and the
tables below name every variable it reads.

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

## Jobs, schedules and what they write

Every business job is a plain function that pg-boss calls; the queue names and
cron strings live in `apps/worker/src/jobs/queues.ts` and nowhere else. ADR-0006
D1-D4 and D5/D10 are the decisions; this table is the operational summary.

| Queue | Schedule | What it does | Safe to rerun? |
|---|---|---|---|
| `jobs.dead-letter` | - | Nothing. It is where a permanently failed job lands, and the handler logs one line per job (original queue and slot id). | Yes - it only logs. |
| `invites.expire` | `*/10 * * * *` | `INVITED` slots past `inviteExpiresAt` become `EXPIRED`. Writes `status` only. | Yes. The write is a CAS on the same predicate, so a second run finds nothing to do and an accept that won the race is untouched. |
| `settlement.sweep` | `*/15 * * * *` | Enqueues one `settlement.settle-slot` per `IN_PROGRESS`, non-deleted slot whose window is still open (`settlementEndsAt > now`). | Yes. It writes nothing; a repeat inside the same 15-minute bucket is suppressed, and is counted as `suppressed`, not as work. |
| `settlement.settle-slot` | - | One slot, one final read of the platform's metrics (ADR-0006 D5). | Yes. `ADVANCED`/`NO_CHANGE` are idempotent, and the singleton key keeps one job per slot per 15-minute bucket. |
| `settlement.close-sweep` | `*/15 * * * *` | Enqueues one `settlement.close-slot` per `IN_PROGRESS`, non-deleted slot whose window has ended (`settlementEndsAt <= now`). | Yes. It writes nothing; a repeat is a suppressed send. |
| `settlement.close-slot` | - | One slot: a final read, then `status = CLOSED` with `closedAt` if the read succeeded and escrow is still unreleased (ADR-0006 D10). | Yes. The close is a CAS; a second run on a closed slot is a no-op. |

The two sweeps split the slot table at `settlementEndsAt`: `> now` settles, `<= now`
closes, and a slot with no window is selected by neither. Both jobs re-check the
row themselves, so the enqueue is never the decision.

### Environment variables the settlement jobs read

Names only. The values live in the platform's secret store, are never in a file
in the repository, and are never printed by the worker or by this runbook.

| Variable | Required |
|---|---|
| `YOUTUBE_CLIENT_ID` | yes |
| `YOUTUBE_CLIENT_SECRET` | yes |
| `YOUTUBE_REDIRECT_URI` | yes |
| `YOUTUBE_TOKEN_ENCRYPTION_KEY` | yes |
| `INSTAGRAM_TOKEN_ENCRYPTION_KEY` | optional - only if Instagram settlement is enabled |

A missing required one exits **2** at startup, before the database is contacted,
with the variable names and nothing else (ADR-0006 D6, D8).

## Reading the dead-letter queue

Dead-lettered jobs are rows in pg-boss's own `job` table. In pg-boss 12.38.0 that
is `job` (`dist/plans.js:104`, `BASE_JOB_TABLE`), created by `createTableJob`
(`dist/plans.js:834`) with the columns used below; `source_name`, `source_id`,
`source_created_on`, `source_retry_count` and `source_output` are the provenance
of the job that failed (`dist/plans.js:835-845`, copied on the transfer at
`dist/plans.js:3213`). The table is partitioned by `name`, so selecting from
`pgboss.job` reads the parent and every partition.

Substitute `PGBOSS_SCHEMA` if the deployment set it to something other than the
default `pgboss` (schema names cannot be bound as parameters).

```sql
-- READ ONLY. LIMIT is part of the query, not a suggestion.
SELECT id,
       source_name,
       data->>'slotId' AS slot_id,
       state,
       retry_count,
       created_on,
       output
FROM pgboss.job
WHERE name = 'jobs.dead-letter'
ORDER BY created_on DESC
LIMIT 20;
```

- `source_name` is the queue the job originally failed on; `source_id` is that
  job's id. `slot_id` comes out of the job's `data` - the only field the worker
  puts there is `{ slotId }`.
- `state` and `retry_count` say how far it got. `created_on` is when the copy
  was made, which is roughly when the last attempt failed.
- **`output` can contain the error text from the failed attempt.** It is written
  by pg-boss, not by the worker's logger, so the worker's key-based redaction
  never sees it. Read it in place, redact before pasting it anywhere (a ticket, a
  chat, a status page), and assume it can quote SQL, a host name or a connection
  string. Never paste a row verbatim.

A dead-letter row is the loudest signal this system gives that money did not
move. There is no alert destination yet (ADR-0006 OQ-3), so reading this queue is
a manual step after anything that looks like a failed settlement.

## A slot stuck past its window

A settlement that can never be read - a revoked social account, a deleted video,
a provider that keeps failing - cannot be closed: `settlement.close-slot` closes
only after a final read that succeeded (ADR-0006 D10), because closing on a read
that never happened would close a slot whose figures were never taken. Such a
slot stays `IN_PROGRESS` with its escrow still committed, and its close job
warns on every sweep.

Find them read-only:

```sql
-- READ ONLY.
SELECT id, status, "settlementEndsAt", "paidToDate", "escrowAmount"
FROM "CampaignCreatorSlot"
WHERE status = 'IN_PROGRESS'
  AND "deletedAt" IS NULL
  AND "settlementEndsAt" < now()
ORDER BY "settlementEndsAt" ASC
LIMIT 50;
```

Then read the worker logs for the close job's warning lines. They carry the slot
id, the outcome code and a reason code, never an amount:

- `settlement.close-slot: the final read did not succeed` with
  `outcome: 'SKIPPED_NOT_ELIGIBLE'` or `'HELD_NO_DATA'` and a `reason` (for
  example `social_account_revoked`, `content_id_null`, `no_analytics_data`);
- `settlement.close-slot: negative unreleased escrow` or
  `nothing unreleased on an open slot` - both are `error` lines that need a human,
  and neither closes the slot.

The slot is not closed automatically because the grace period that would allow
it is a product decision, still open (ADR-0006 OQ-10).

## Two replicas are safe

Running more than one worker process is supported. Every state change is a
compare-and-swap on the condition that was read (`invites.expire`) or on the
exact values read (`settlement.close-slot`), so the loser of a race writes
nothing and logs counts or `changed concurrently` at `info`. Per-slot queues use
`policy: 'short'` with `singletonKey`/`singletonSeconds`, so two sweeps cannot
queue two jobs for the same slot in the same bucket; the second send is
suppressed and counted as `suppressed`, which is not an error.

## Money discipline

Expiry and window close move **no money**:

- `invites.expire` writes `status = EXPIRED` and nothing else.
- `settlement.close-slot` writes `status = CLOSED` and `closedAt` and nothing
  else. `escrowAmount` and `paidToDate` are unchanged and no `PayoutEvent` is
  written. A `CLOSED` slot keeps counting its full escrow against the campaign's
  committed total.

The only job that writes `PayoutEvent` rows is `settlement.settle-slot`, through
`apps/web`'s settlement engine, which is append-only at the database level.

## Pre-deploy checklist

- [ ] `DATABASE_URL` is the session pooler (port 5432, no `pgbouncer=true`) and
      is set only on the worker service.
- [ ] The settlement variables above are set on the worker service only.
- [ ] **Do not point the worker at a database that has not had the Data API/RLS
      review.** The worker connects as a role that bypasses the Data API's
      row-level security, so a claim like "the API only returns a creator's own
      rows" says nothing about what the worker can read and write. That review is
      a separate gate and is not performed by deploying.
