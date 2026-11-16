# ADR-0006: Worker jobs, schedules and the settlement boundary

- Status: Proposed
- Date: 2026-11-16
- Related: ADR-0003 (D1, D5, OQ-5), ADR-0004 (D1, D2), ADR-0005 (D3, D4)

## Context

ADR-0003 D5 put settlement in a separate `apps/worker` on pg-boss. ADR-0005
settled the host, the connection mode and the code-sharing rule. Stage 1 of the
worker implemented that host and nothing else: configuration, logging, one ping
queue, graceful shutdown.

This ADR covers the first business jobs, delivered in three stages:

- **Stage 1** - invite expiry.
- **Stage 2** - the settlement sweep and one settle-slot job per slot.
- **Stage 3** - the window-close sweep and one close-slot job per slot.

Stages 2 and 3 are recorded here because the decisions they depend on are cheap
while no job exists and expensive once real money has moved on them. Only Stage 1
is implemented; the rest of this document is the contract those stages must meet.

Constraints that hold for every job, and that the tests enforce:

1. No schema and no migration in this work. The columns already exist.
2. No new dependency. pg-boss, zod and Prisma are what the worker has.
3. A job is a plain async function over a context. It registers nothing, keeps no
   state between runs and is called directly by its test.
4. Every state change is a compare-and-swap on the condition that was read.
5. Every batch is bounded: at most 100 rows per statement and at most 20
   statements per run.
6. Every job is idempotent: running it twice changes nothing the second time.
7. Raw SQL, where it is used at all, is a tagged `$queryRaw` with bound
   parameters - never `$queryRawUnsafe`.
8. Logs carry a slot id, counts, durations, an error name and an error code.
   Never an error message, never a row, never a token.
9. The clock is injected. A job never reads `Date.now()` itself.
10. Job data is `{ slotId }` and is validated with zod on both sides.

## Decisions

### D1. Invite expiry writes `status` and nothing else

The job expires every slot whose `status` is `INVITED` and whose
`inviteExpiresAt` is at or before the current instant, by updating the status to
`EXPIRED`. That is the whole write.

- **No `expiredAt`.** The column does not exist, and this work may not add one.
- **No `cancelledAt`.** An expired invite was not cancelled. Writing a
  cancellation timestamp would put a false event in the record that a later
  dispute would have to reason about.
- **A NULL `inviteExpiresAt` never matches.** The predicate is
  `{ not: null, lte: now }`: the comparison itself excludes NULL, and the `not:
  null` states the intent so a refactor cannot drop it silently. A slot invited
  without a window is not expired by a job guessing at one.
- **`deletedAt` is not filtered.** `create-invite.ts` counts soft-deleted slots
  in a campaign's committed escrow, deliberately: "Soft-deleted slots are
  deliberately NOT excluded: escrow may already have been committed". A
  soft-deleted `INVITED` slot therefore still holds budget, and `EXPIRED` is one
  of the `FREED_ESCROW_STATUSES`. Excluding it here would leave that amount
  committed forever with no state that accounts for it. ADR-0004's rule is
  "expire exactly the rows whose status is INVITED", and this follows it.
- **The write is a CAS.** The `updateMany` repeats the read's predicate and adds
  the ids, so a slot accepted, declined or cancelled between the `SELECT` and the
  `UPDATE` is left alone. Losing that race is normal; it is logged as counts.
- **The read is bounded and index-friendly.** `where { status, inviteExpiresAt }`
  with `orderBy inviteExpiresAt` uses the existing
  `[status, inviteExpiresAt]` index; pages of 100, at most 20 pages per run.
- **One clock read per run.** `now` is read once, so every statement in a run
  makes the same decision even if it straddles a second boundary.
- **Truncation is measured, not guessed.** When a run stops at its budget it
  counts the remaining work before claiming `truncated: true`, so a run that ends
  on an exact multiple of the budget does not report a backlog it does not have.

### D2. `registerJobs` is the fourth parameter of `startWorker`

`startWorker(config, logger, createBoss?, registerJobs?)` starts pg-boss, creates
the ping queue and its handler, and then calls `registerJobs(boss)` - after
`start()`, before the handle is returned. A failing registration fails the start:
a host that is running but deaf is worse than one that exits.

The fourth positional parameter (rather than an options object) keeps every
existing call site and test unchanged. Business registration lives in
`jobs/register.ts`, not in `worker.ts`: the host stays testable with no database
and no business jobs.

### D3. Six queues, two schedules

| Queue                     | Kind      | Schedule        | Purpose                                |
| ------------------------- | --------- | --------------- | -------------------------------------- |
| `jobs.dead-letter`        | consumer  | -               | Terminal landing place for failed jobs |
| `invites.expire`          | cron      | `*/10 * * * *`  | Expire invites past their window       |
| `settlement.sweep`        | cron      | `*/15 * * * *`  | Yield one settle-slot job per open slot |
| `settlement.settle-slot`  | consumer  | -               | One slot, one read                     |
| `settlement.close-sweep`  | cron      | `*/15 * * * *`  | Yield one close-slot job per ended slot |
| `settlement.close-slot`   | consumer  | -               | Close a slot whose window ended         |

The dead-letter queue is created first: every other queue names it in a column
with a foreign key, so creating a queue that references a queue that does not
exist fails. `createQueue` is `INSERT ... ON CONFLICT DO NOTHING` and `schedule`
updates the row for the same `(name, cron)` pair, so registration is safe on
every boot and needs no migration of its own.

Names and schedules live in one module (`jobs/queues.ts`) so registration, the
runbook and the tests cannot drift apart.

### D4. Five attempts, then the dead-letter queue

Every business queue is created with `retryLimit: 4` and `retryBackoff: true`
starting at 60 seconds: pg-boss counts retries, so this is five attempts in
total, spread over roughly sixteen minutes. That outlasts a database failover and
is short enough for a human to react.

After the last attempt the job is copied into `jobs.dead-letter`. The copy is
named after the dead-letter queue itself; the queue it originally failed on is
`sourceName`, which pg-boss only returns when the handler asks for
`includeMetadata: true`. The handler logs that original queue and the slot id at
`error` level - one line per permanently failed job, which is the only signal
this system currently gives that money did not move.

The handler wrapper is shared by every job:

- `debug` on start, with the queue name;
- `info` on success, with the queue, the duration and the job's summary counts;
- `error` on failure, with the queue, the duration, the error name and the
  Prisma code - never the message, which can quote a connection string or a
  token - and the error is rethrown so pg-boss owns the retry.

### D5. `settleSlot(slotId, prisma, metrics)` takes an injected client

The settlement function in `apps/web` already has the shape this worker needs:
the slot id, the database client and a metrics provider are all parameters. The
worker passes its own client and the YouTube provider bound in `buildDeps()`, so
the same function runs in a route handler and in a job with no global state to
reset between tests.

Two of its outcomes are return values, not errors:

- `SKIPPED_NOT_ELIGIBLE` - the slot is not in a state that can settle;
- `HELD_NO_DATA` - the read could not produce data (unreachable API, missing
  content id, a metric the provider would not answer).

A skipped or held outcome is logged by reason code and the job completes: it is
an answer, and retrying it would ask the same question again. Only an outcome
that actually read metrics counts as the final read; `HELD_NO_DATA` never does.
A thrown error is rethrown so pg-boss retries, except `SettlementError` for a slot
that no longer exists, which completes with a `warn`.

### D6. Startup order is part of the contract

1. Configuration, validated with zod. Failure exits **2**, with variable names
   and reasons only.
2. Logger.
3. Database: `@repo/database` is **dynamically imported**, then proven with a
   tagged `$queryRaw` `SELECT 1`. Either failure logs one fixed message
   (`database client failed to initialise`) with the error name only and exits
   **1**. A worker that cannot reach its database does not hold a pg-boss pool
   open waiting for a fix.
4. Dependencies: `jobs/deps.js` is dynamically imported and `buildDeps()` is
   called. In Stage 2 this is where the settlement preflight runs, and a missing
   variable exits **2** with variable names only.
5. pg-boss: start, then `registerJobs`.

The dynamic imports are not style. The Prisma singleton and the web app's
modules read `process.env` as they are imported, so a static import in `main.ts`
would make the process fail on an environment it has not validated yet (Stage 2
would report a missing settlement variable before the configuration check ever
ran). They also keep `main.ts`'s static graph free of the database and the web
app, which `startup-graph.test.ts` asserts by walking relative imports and
failing on the full chain to `@repo/database`, `@/...` or `jobs/deps.ts`.

Shutdown closes the same client it opened: `worker.stop()` first, then
`prisma.$disconnect()`.

### D7. `jobs/deps.ts` is the only value importer of `apps/web`

ADR-0005 D4 allows the worker to import settlement code straight from
`apps/web/src`. This decision narrows that to one module.

- `jobs/deps.ts` value-imports the four settlement modules and binds them into
  `JobDeps`: `@/lib/settlement/settle-slot`,
  `@/lib/settlement/adapters/youtube`, `@/lib/slots/resolve-dispute`,
  `@/lib/slots/constants`.
- Everywhere else, a web type arrives with `import type`, which the compiler
  erases - the module is never loaded.
- `worker-imports.test.ts` enforces both halves: no module except `deps.ts` may
  value-import from `@/`, and a type import may name only those four modules. The
  worker's coupling to the web app is a decision, so adding to it has to be a
  change to this ADR rather than a convenience import.

### D8. The worker holds the settlement environment and nothing else

The worker's process environment carries exactly four settlement variables:

- `YOUTUBE_TOKEN_ENCRYPTION_KEY`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REDIRECT_URI`

They are delivered by a separate `apps/web` change on branch
`refactor/settlement-env-scope`, which splits the environment so that importing
settlement code no longer requires the whole web schema. That change lands before
Stage 2.

Until it lands, the worker cannot import `@/lib/settlement/adapters/youtube` at
all: `apps/web/src/lib/env.ts` parses its full schema at module scope, so the
import throws a `ZodError` listing ten missing variables - the four above plus
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `INSTAGRAM_APP_ID`,
`INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI` and
`INSTAGRAM_TOKEN_ENCRYPTION_KEY`. The worker will never hold Clerk or Instagram
credentials; the split is what makes that true in code and not just in intent.

There is no `config.settlement.ts`. The preflight is `parseSettlementEnv` from
that split, called from `buildDeps()`, and a failure becomes a `ConfigError`
naming variables only - exit **2**, the same contract as the worker's own
configuration.

## Consequences

- Stage 1 registers one queue and one schedule. The other names in
  `jobs/queues.ts` are declared but unused until Stages 2 and 3, so the runbook
  and the ADR describe the target state while the code describes today's.
- Invite expiry is eventually consistent within ten minutes. A slot can be
  accepted in the window between its expiry instant and the next sweep; the CAS
  makes that safe, and the accept wins.
- Expiry is what releases a discarded invite's committed escrow, including for a
  soft-deleted slot. Without it the campaign budget would stay spent on an invite
  nobody will ever accept.
- A dead-lettered job is currently visible only in the logs and in the
  `jobs.dead-letter` queue. There is no alert destination yet (OQ-3).
- The two import rules are now tests, not review conventions: a convenience
  `import { prisma }` from the web app, or a static database import in `main.ts`,
  fails the suite with the chain that caused it.
- Stage 1 makes no schema change and adds no dependency. Everything it needs -
  `[status, inviteExpiresAt]`, `EXPIRED`, the `FREED_ESCROW_STATUSES` list - was
  already there.

## Open questions

- **OQ-1.** The brand review window (`reviewDueAt`, five days) has no owner yet:
  does a missed review expire the submission, cancel the slot, or leave it for a
  human?
- **OQ-2.** How long may a slot stay `HELD_NO_DATA` before it is treated as
  permanently unreadable rather than temporarily unreachable? The grace period
  decides whether the window closes on a slot that could still settle.
- **OQ-3.** Where do dead-letter alerts go? Today the queue is a place jobs stop;
  nothing watches it.
- **OQ-4.** YouTube Analytics has a daily quota. What should a sweep do when it
  is exhausted mid-run - stop and resume next sweep, or slow down?
- **OQ-5.** Per-job metrics (sweep duration, expired counts, dead-letter rate) -
  are the logs enough, or does this need a metrics endpoint?
- **OQ-6.** A slot whose social account was revoked can never produce a final
  read: the provider will not answer for a connection that no longer exists. The
  slot stays `IN_PROGRESS` past its window with no state that ends it. Does it
  close with unreleased escrow (ADR-0004 D2), go to dispute, or need an operator
  decision?
