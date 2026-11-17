# ADR-0005: Worker host, database connection mode and code sharing

- Status: Proposed
- Date: 2026-11-15
- Related: ADR-0003 (D5, OQ-5), ADR-0004

## Context

ADR-0003 D5 decided that settlement runs in a separate `apps/worker` service on
pg-boss, that a singleton key per slot prevents double processing, and that the
worker never runs migrations. It left the host open as OQ-5. ADR-0004 then added
CLOSED and the dispute transitions the worker will have to honour.

Building the service surfaced four decisions that ADR-0003 did not make and that
are expensive to reverse once real jobs exist: where the process runs, how it
connects to Supabase, what "the worker never runs migrations" means when pg-boss
installs its own schema, and how the worker reuses settlement code that today
lives inside `apps/web`. A fifth decision, how it runs in production, follows
from the tooling already in the repository. A sixth, which secrets it holds,
follows from the work it will do next.

This ADR settles all six before the first job exists, so the deployment shape and
the code boundary are reviewable while they are still cheap to change. Stage 1 of
`apps/worker` implements the host only: configuration, logging, the pg-boss
connection, a ping queue and graceful shutdown. It contains no sweepers, no
settlement and no expiry jobs.

## Decisions

### D1. Railway runs `apps/worker` as an always-on service

The worker is a plain Node process: no platform-specific API, no proprietary
queue, no host-provided scheduler. Its deployment contract is "run
`pnpm --filter worker start` under a process supervisor that restarts on
failure", which Railway, Render and Fly.io all provide. Moving hosts is a
configuration change, not a code change.

Serverless cron is rejected. pg-boss needs a persistent database connection, and
a settlement run must be able to outlive a function timeout: a job that is killed
mid-transaction either rolls back (and the work is silently deferred to the next
schedule) or is recorded as failed while its side effects committed. Neither is
acceptable around money.

Railway-specific settings (root directory, install and start command, restart
policy, spend cap) are documented in `docs/runbooks/worker.md` rather than here,
because they are operational detail that may change without changing this
decision.

### D2. The worker connects through Supabase's session-mode pooler

`DATABASE_URL` for the worker must be the Supabase **session pooler** string:
Connect panel, Session pooler, port 5432 on the pooler host. It is IPv4
compatible, so it works from any host without extra networking.

Two alternatives are refused at startup, before pg-boss is constructed:

- the **transaction pooler** (port 6543, or any URL carrying `pgbouncer=true`).
  pg-boss relies on session state and advisory locks, which transaction pooling
  does not preserve. The failure mode is not a clean error at boot; it is jobs
  that stop being claimed, or locks that are released when a connection is
  handed to the next client;
- the **direct connection**. It is IPv6-only unless Supabase's IPv4 add-on is
  bought, so it would make the deployment depend on a paid add-on and on the
  host's IPv6 support.

`assertSessionModeUrl()` in `apps/worker/src/config.ts` enforces the refusal and
reports the reason without echoing the URL.

Connection budget. The worker opens two pools against the same `DATABASE_URL`:
pg-boss with `PGBOSS_POOL_MAX` connections (default 4) and the shared Prisma
singleton through `@prisma/adapter-pg`, which creates a node-postgres `Pool` with
its default `max` of 10. That is 4 + 10 = 14 connections per worker instance, and
more if pg-boss's optional LISTEN/NOTIFY listener is ever enabled (it holds one
dedicated session-pinned connection and is off today). The web service draws
from the same Supabase pooler budget, and that budget depends on the project's
compute size. Check the pooler's client limit in the dashboard before raising
`PGBOSS_POOL_MAX` or the Prisma pool; neither number is safe to raise on the
assumption that the pooler has room.

### D3. pg-boss owns its schema; the worker never touches `public`

pg-boss is configured with `PGBOSS_SCHEMA` (default `pgboss`), installs the
schema on first start and upgrades it on later starts. It owns every object it
creates there.

"the worker never runs migrations" (ADR-0003 D5) means exactly this:

- it never touches the application schema (`public`);
- it never runs `prisma migrate`, `prisma db push` or a Prisma migration API;
- it issues no DDL outside its own `pgboss` schema.

The connecting role therefore needs `CREATE` on the database, because a first
deployment has to create that schema. That is a wider privilege than the worker's
queries need, which is why D6 proposes narrowing the role later rather than
pretending the requirement does not exist.

The schema name is validated against a lowercase Postgres identifier pattern
before it reaches pg-boss, so a misconfigured variable cannot inject SQL into the
schema name pg-boss quotes.

### D4. The worker imports settlement code from `apps/web/src`, with a guard

The settlement engine (`settleSlot()`, the YouTube adapter, the dispute resolver
and the slot constants) lives in `apps/web/src/lib`. Duplicating it into
`apps/worker` would create two implementations of money arithmetic that must
agree forever; extracting it into a workspace package today would touch every
import in `apps/web` before the worker has run a single job.

So the worker imports those modules directly through a tsconfig path alias:
`@/*` maps to `../web/src/*`, and `apps/worker` has no build step. The worker
does not import anything from `apps/web` yet; the alias and the guard exist now
so the boundary is enforced from the first import, not retrofitted after the
first violation.

`apps/worker/src/import-guard.test.ts` walks the import graph from four entry
modules (`lib/settlement/settle-slot.ts`, `lib/settlement/adapters/youtube.ts`,
`lib/slots/resolve-dispute.ts`, `lib/slots/constants.ts`), resolving relative
paths and the `@/` alias, and fails with the full chain if any reachable module
imports `next`, `next/*`, `@clerk/*`, `react`, `react-dom`, `server-only`,
`client-only`, or the web-only paths `@/lib/http`, `@/lib/auth`, `@/app`,
`@/components`. A reachable Next.js or React dependency would mean the worker
cannot start as a plain Node process, and the guard is cheaper than discovering
that in production.

This is a boundary, not a permanent architecture. Extract a workspace package
when a third consumer appears, or when the guard forces a web module to be
restructured to stay importable.

### D5. The worker runs under tsx, with no compile step

`pnpm --filter worker start` is `tsx src/main.ts`. tsx is a dependency, not a dev
dependency, because production runs it. There is no `build` script and no `dist`
directory, so a deployment cannot run stale output built from different source,
and `turbo run build` / `turbo run lint` skip the package entirely.

The generated Prisma client is committed to the repository, so no `prisma
generate` step is needed at deploy time; the worker's type check and runtime both
consume the client that is in the tree.

Type safety is a check, not a build: `pnpm --filter worker exec tsc --noEmit`
runs in CI and fails the build on a type error, but nothing is emitted.

### D6. Secrets and privilege

The worker will hold the token-decryption key and the YouTube client credentials
(the same values `apps/web` uses for the YouTube connection:
`YOUTUBE_TOKEN_ENCRYPTION_KEY`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`).
They are set only in the worker service's own environment variables, never in a
shared or committed file, and never logged. The worker's logger redacts any field
whose key matches `pass`, `secret`, `token`, `authorization`, `cipher`, `key`,
`url` or `cookie`, at every depth, and `DATABASE_URL` is never printed.

Stage 1 does not read these secrets: configuration currently accepts only
`DATABASE_URL`, `PGBOSS_SCHEMA`, `PGBOSS_POOL_MAX`, `SHUTDOWN_TIMEOUT_MS`,
`LOG_LEVEL` and `NODE_ENV`. They are named here so that the rule is decided
before the code that needs them exists.

Recommended hardening, deliberately not done in this stage: a dedicated database
role for the worker with `UPDATE` on the slot tables, `INSERT` on the payout
ledger, `SELECT` where needed, and no `DELETE` or `TRUNCATE` anywhere. That role
would also be the one granted `CREATE` for the `pgboss` schema, so the worker's
ability to create objects stays inside the schema it owns. It is deferred because
it changes the connection string, the grants and the migration story at once, and
none of that is worth doing before the worker has jobs to run.

## Consequences

- OQ-5 is answered: Railway, with Render and Fly.io as configuration-only
  alternatives.
- A boot with a transaction-pooler URL fails loudly with exit code 2 and one
  line naming the problem. That is intentional: a worker that starts against the
  wrong pooler looks healthy until jobs stop draining.
- The worker and the web app share one connection budget. Raising
  `PGBOSS_POOL_MAX` is a capacity decision that must include the Prisma pool and
  the pooler's own limit.
- The worker needs `CREATE` on the database for its first start. A role without
  it fails during `boss.start()` rather than later, which is the correct time to
  find out.
- The import guard makes `apps/web/src/lib/settlement` and
  `apps/web/src/lib/slots` effectively "shared code with a Node-only contract".
  A change there that reaches for Next.js, Clerk or React will fail the worker's
  test suite even if the web build is happy.
- `apps/worker` has no build output to deploy, so the deployed code is exactly
  the committed source. A type error cannot reach production through a stale
  `dist`, because there is no `dist`.
- Stage 1 ships a `system.ping` queue and nothing else. Settlement, expiry and
  the sweepers remain unimplemented until the next task.

## Open questions

- OQ-1. Where do dead-letter queue alerts go? ADR-0003 D5 requires an alert when
  a job lands in the DLQ, but no alerting destination has been chosen. Until one
  is, a DLQ job is visible only to whoever reads the table.
- OQ-2. When is the dedicated worker database role introduced (D6)? It needs a
  grant set, a separate connection string and a documented way to run it next to
  the Prisma migrations that still use the owner role.
- OQ-3. Which region should the worker run in relative to the Supabase database?
  Every settlement run opens a transaction per slot, so cross-region latency is
  paid per slot rather than per request. Railway's region should be chosen
  together with the Supabase project's region, and neither is fixed yet.
