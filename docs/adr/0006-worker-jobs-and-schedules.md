# ADR-0006: Worker jobs, schedules and the settlement boundary

- Status: Proposed
- Date: 2026-11-16
- Related: ADR-0003 (D1, D5, OQ-5), ADR-0004 (D1, D2), ADR-0005 (D3, D4)

## Context

ADR-0003 D5 put settlement in a separate `apps/worker` on pg-boss. ADR-0005
settled the host, the connection mode and the code-sharing rule. The host came
first and did nothing but host: configuration, logging, one ping queue, graceful
shutdown. Invite expiry followed, and then settlement.

This ADR covers the worker's business jobs as they land:

- invite expiry (D1);
- the settlement sweep and one settle-slot job per slot (D3, D5);
- the window-close sweep and one close-slot job per slot, not implemented yet.

The parts that are not implemented yet are recorded here because the decisions
they depend on are cheap while no job exists and expensive once real money has
moved on them: the rest of this document is the contract those jobs must meet.

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

#### D3a. `createQueue` does not change a queue that already exists

That `ON CONFLICT DO NOTHING` has a consequence worth stating: an option added to
a queue that already exists is silently **not applied**. The row keeps the policy,
retry limits and expiry it was first created with. Changing any of them on a
deployed queue therefore needs an explicit `updateQueue(name, options)` - pg-boss
12.38.0 exposes `updateQueue`, `getQueue` and `deleteQueue` - not a new
deployment. Reading the policy back with `getQueue` is the only way to prove a
live queue really is what the code says; `register.settlement.test.ts` pins the
options we pass and `pg-boss-settlement-queue.test.ts` reads the policy back.

#### D3b. One settle job per slot, and what the sweep selects

`settlement.settle-slot` is created with `policy: 'short'`, and every send carries
`singletonKey: 'settle:<slotId>'` with `singletonSeconds: 900`.

- **`policy: 'short'`** allows at most one *queued* job per singleton key, with no
  limit on active ones. That bound does not depend on a time window, so two
  sweeps that run before a worker picks the job up cannot leave two settle jobs
  for one slot.
- **`singletonSeconds: 900`** puts the send in an epoch-aligned 15-minute bucket
  and allows at most one job per key per bucket in any state except cancelled, so
  a slot is settled at most once per bucket even if the sweep runs more often.
- **A suppressed send is a no-op, not an error.** pg-boss inserts nothing and
  resolves `null`; the sweep counts those as `suppressed` and only inserted ids
  as `enqueued`. Without that split a throttled sweep would report work it never
  handed off.

The settle job runs with `localConcurrency: 2`: every settle spends YouTube
Analytics quota, so the ceiling that matters is the day's quota, not CPU.

`settlement.sweep` selects slots that are `IN_PROGRESS`, not soft-deleted, with
`settlementEndsAt > now`. A NULL window never matches - the comparison excludes
NULL, and the sweep would have no way to tell a missing window from a broken one
- and a window ending exactly at `now` counts as ended: the close sweep owns that
slot, not this one. `settleSlot` keeps no "next run" field: it writes
`currentTier`, `paidToDate`, `currentViewCount` and `lastViewCheckAt`, and at
`TIER_100` it writes `status = COMPLETED`.

A sweep keeps no progress either - no stored cursor, and enqueueing changes no
row. What makes a second run reach the slots the first one's budget cut off is
the **order**:

```
lastViewCheckAt ASC NULLS FIRST, id ASC
```

`lastViewCheckAt` records that a read happened, not when the next one is due, but
that is exactly what is needed here: a slot read by `ADVANCED` or `NO_CHANGE`
carries a timestamp and sorts behind every slot that has not been read since,
including every slot that was never read at all. Ties break by id, so the order is
total and the paging is stable. The sweep pages that order with `skip`/`take`
(100 ids per statement, 20 pages, 2,000 slots per run) rather than a keyset,
because a keyset over a nullable first column would need raw SQL to express
NULLS FIRST (R5).

A run that stops at its budget logs at `warn` with counts and the cap, and sets
`truncated` by asking for one row past the cap - not by counting.

**The limitation.** `SKIPPED_NOT_ELIGIBLE` and `HELD_NO_DATA` write nothing, so
such a slot keeps a NULL `lastViewCheckAt` and holds its place at the front. More
than one run's budget of them, and the slots behind them are never reached, no
matter how many runs pass. That is OQ-9, and this stage does not fix it.

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

The job (`jobs/settle-slot.ts`) re-loads the slot first and decides what it can
without spending quota:

- a slot that no longer exists is a `warn` and a completed job - there is nothing
  left to retry;
- a slot that is no longer `IN_PROGRESS`, is soft-deleted, is disputed or whose
  window has ended is a skip with a reason code, and the provider is never called;
- every outcome the engine returns is handled by an exhaustive switch whose
  default asserts `never`, so a new outcome in `apps/web` stops the worker
  compiling instead of being ignored at runtime.

Every error thrown by `settleSlot` is rethrown, with no `instanceof` branch. In
particular `SettlementError` is **not** read as "the slot is gone": the escrow
invariant - `paidToDate` exceeding `escrowAmount` - is thrown as a
`SettlementError` from inside the settlement transaction, so swallowing it would
log a money failure as a settled slot and never retry it. It retries per D4 and
ends in the `jobs.dead-letter` log, which is the loudest signal this system has.

### D6. Startup order is part of the contract

1. Configuration, validated with zod. Failure exits **2**, with variable names
   and reasons only.
2. Logger.
3. Settlement environment: `jobs/deps.js` is **dynamically imported** and
   `loadSettlementEnv(process.env)` runs *before* any database client exists. A
   `ConfigError` is written as `worker: <message>` and exits **2**, the same
   contract as step 1; any other failure is the fixed
   `job dependencies failed to initialise` line and exit **1**. See D8.
4. Database: `@repo/database` is **dynamically imported**, the worker's own
   client is built (D9), then it is proven with a tagged `$queryRaw` `SELECT 1`.
   Either failure logs one fixed message (`database client failed to initialise`)
   with the error name only and exits **1**. A worker that cannot reach its
   database does not hold a pg-boss pool open waiting for a fix.
5. Dependencies: `buildDeps()` binds the web app's settlement code. A missing
   `settleSlot` binding is a startup failure, exit **1**: a worker that accepts
   settlement work and drops it is worse than one that refuses to start, which is
   why registration is never gated on it.
6. pg-boss: start, then `registerJobs`.

The settlement preflight sits before the database on purpose. A missing YouTube
variable is a configuration problem, and reporting it after a connection failure
would send an operator to the connection string to look for a missing key.
`startup-preflight.test.ts` spawns the real entry point to pin the order: with a
refused database and no settlement variables the process exits **2** and never
touches the database.

The dynamic imports are not style. The Prisma singleton and the web app's
modules read `process.env` as they are imported, so a static import in `main.ts`
would make the process fail on an environment it has not validated yet - a
missing settlement variable would be reported from a module-scope parse, with a
stack, before the configuration check ever ran. They also keep `main.ts`'s static
graph free of the database and the web app, which `startup-graph.test.ts` asserts
by walking relative imports and failing on the full chain to `@repo/database`,
`@/...` or `jobs/deps.ts`.

Shutdown closes the same client it opened: `worker.stop()` first, then
`prisma.$disconnect()`.

### D7. `jobs/deps.ts` is the only value importer of `apps/web`

ADR-0005 D4 allows the worker to import settlement code straight from
`apps/web/src`. This decision narrows that to one module.

- `jobs/deps.ts` value-imports the four settlement modules and binds them into
  `JobDeps`: `@/lib/settlement/settle-slot`,
  `@/lib/settlement/adapters/youtube`, `@/lib/slots/resolve-dispute`,
  `@/lib/slots/constants`.
- It also value-imports `@/lib/env-parts` for `loadSettlementEnv`, the narrow
  schema D8 depends on. That module parses nothing at import time, which is what
  makes it safe to load before the database exists.
- Everywhere else, a web type arrives with `import type`, which the compiler
  erases - the module is never loaded.
- Test files may import a web value to build a fake: they never ship, and the
  guard walks the production graph from `main.ts`.
- `worker-imports.test.ts` enforces both halves: no production module except
  `deps.ts` may value-import from `@/`, and a type import may name only those four
  modules. The worker's coupling to the web app is a decision, so adding to it has
  to be a change to this ADR rather than a convenience import.

### D8. The worker holds the settlement environment and nothing else

The worker's process environment carries exactly four settlement variables:

- `YOUTUBE_TOKEN_ENCRYPTION_KEY`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REDIRECT_URI`

They are parsed by `parseSettlementEnv` in `apps/web/src/lib/env-parts.ts`, which
the `apps/web` change that split the environment introduced: importing settlement
code no longer requires the whole web schema.

That split is what makes the four-variable claim true in code rather than in
intent. Before it, `apps/web/src/lib/env.ts` parsed its full schema at module
scope, so importing `@/lib/settlement/adapters/youtube` threw a `ZodError`
listing ten missing variables - the four above plus
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `INSTAGRAM_APP_ID`,
`INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI` and
`INSTAGRAM_TOKEN_ENCRYPTION_KEY`. The worker will never hold Clerk or Instagram
credentials.

There is no `config.settlement.ts`. The preflight is `loadSettlementEnv(source)`
in `jobs/deps.ts`, which `main.ts` calls before the database (D6): it turns a
`ZodError` into a `ConfigError` naming the failing issue paths and nothing else -
never `message` and never the parsed value, both of which can quote a secret - so
it exits **2** with variable names only.

### D9. The worker builds its own Prisma client with the `worker` profile

`@repo/database` exports `createPrismaClient({ connectionString, profile,
connectTimeoutMs })`, and the worker calls it with `profile: 'worker'` instead of
using the shared singleton:

- **No Prisma-side logging.** The profile resolves to `log: []`. Prisma writes
  `prisma:error` blocks - and, with the `query` level, SQL and its parameters -
  straight to the process output, bypassing the worker's logger and its
  key-based redaction; a rejected login was printing the database user and
  host:port. With the profile in place a failure surfaces only as a thrown
  error, which the worker logs by name and code (`describeError`).
- **An explicit connect timeout.** The worker's adapter gets
  `connectionTimeoutMillis` (10 s), so an unreachable database fails startup in
  about ten seconds instead of waiting out the OS default - measured at 23 s
  before this change.

The `default` profile keeps the web app exactly as it was: the same log arrays
for the same `NODE_ENV` values, the same adapter options, the same caching
condition on `globalThis`, built at import. Nothing on the worker's runtime path
imports the singleton - everything receives the client through `JobContext` -
and importing the package only *constructs* it: pg opens a connection on first
use, so a process that never queries it holds no socket. `db-client.test.ts`
pins both halves: Prisma's output is silent under the `worker` profile, the
`default` profile still prints it (the control), and construction alone prints
nothing.

## Consequences
- The worker registers four queues and two schedules. The window-close names in
  `jobs/queues.ts` are still declared but unused, so the runbook and the ADR
  describe the target state while the code describes today's.
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
- No schema change and no new dependency. Everything the jobs need -
  `[status, inviteExpiresAt]`, `EXPIRED`, the `FREED_ESCROW_STATUSES` list, the
  settlement window column - was already there.
- A slot is settled at most once per 15-minute bucket, and the sweep's own
  throttle is what enforces that. If a read fails after the bucket closes, the
  next sweep in the next bucket is already the retry: there is no per-slot wake-up
  and no next-run column (D3b).
- That retry depends on ordering, not on memory. Because the sweep serves
  never-read slots first and the oldest read next, a slot that was read moves to
  the back by itself and the slots a run could not fit are at the front of the
  next one. It costs no state, and it fails in one direction only: a slot that
  cannot be read never moves, so a backlog of more than 2,000 of them starves the
  rest, loudly (`truncated: true` and a `warn` every run) but permanently (OQ-9).

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
- **OQ-7.** Is a 10 s connect timeout right against a Supabase session pooler?
  A pooler cold start after a long idle period can take longer than a direct
  connection, and a timeout that is too tight turns a slow wake-up into a
  restart loop. Revisit once a cold start has been measured where it runs.
- **OQ-8.** `settleSlot` prints four lines of its own as it runs - a `warn` on a
  skipped or held read, an `info` naming the retry delay, a `log` with the slot
  and its tier names, and a `warn` when it gives up. They bypass the worker's
  logger and its key-based redaction, float past a job that is otherwise silent,
  and a retry storm prints one line per attempt that nothing can rate-limit or
  assert on. They carry only a slot id, attempt counters, a delay and tier names,
  so nothing sensitive leaks today. Routing them through an injectable logger is
  a later change in `apps/web`, not a worker one.
- **OQ-9.** `settleSlot` writes `lastViewCheckAt` only when it actually reads
  (`ADVANCED`, `NO_CHANGE`). A slot that is skipped as ineligible or held for lack
  of data writes nothing, keeps a NULL `lastViewCheckAt`, and therefore keeps its
  place at the front of the sweep's order (D3b). A backlog larger than one run's
  budget - 2,000 slots - of slots that cannot be read means everything behind them
  is never enqueued: the sweep reports `truncated: true` and a `warn` every run and
  still never gets past them. The fix is a marker for the attempt: either
  `settleSlot` records that it tried (an `apps/web` change to the settlement
  module, which the worker may not make), or the worker keeps an attempt marker of
  its own - which needs a column, and this stage may not change the schema. Not
  done here.
