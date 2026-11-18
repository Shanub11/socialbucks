// apps/worker/src/jobs/queues.ts
//
// Queue names, schedules and one retry policy for every business job
// (ADR-0006 D3, D4).
//
// Names and schedules live in one file so that registration, the runbook and the
// tests cannot drift apart: register.ts schedules exactly what is declared here,
// and the tests assert the literal cron strings.
//
// Plain objects rather than typed constants: pg-boss validates queue options at
// createQueue() time, and the call site in register.ts is where the shape is
// checked against its types. Keeping the values literal here means a typo in a
// field name is a type error at the call site instead of a silently ignored
// option.

/**
 * The dead-letter queue. Every business queue names it, so it must exist (and be
 * created) before the others - pg-boss enforces the reference with a foreign key.
 */
export const DEAD_LETTER_QUEUE = 'jobs.dead-letter';

/** Stage 1. Expires invites whose window has passed (ADR-0004). */
export const INVITES_EXPIRE_QUEUE = 'invites.expire';

/** Stage 2. Finds slots whose settlement window is open and yields settle-slot jobs. */
export const SETTLEMENT_SWEEP_QUEUE = 'settlement.sweep';

/** Stage 2. One slot, one final read (ADR-0006 D5, D8). */
export const SETTLE_SLOT_QUEUE = 'settlement.settle-slot';

/** Stage 3. Finds slots whose window has ended with unreleased escrow. */
export const SETTLEMENT_CLOSE_SWEEP_QUEUE = 'settlement.close-sweep';

/** Stage 3. One slot, closed if its final state allows it (ADR-0004 D2). */
export const CLOSE_SLOT_QUEUE = 'settlement.close-slot';

/**
 * Every ten minutes. Invite expiry is a courtesy, not a deadline: a slot that
 * expires a few minutes late still expires before the campaign budget matters,
 * and a tighter cadence would only add empty sweeps.
 */
export const INVITES_EXPIRE_CRON = '*/10 * * * *';

/** Every fifteen minutes, offset from the invite cron so the two do not collide. */
export const SETTLEMENT_SWEEP_CRON = '*/15 * * * *';

/** Every fifteen minutes; must run after the sweep that feeds it in the same hour. */
export const SETTLEMENT_CLOSE_SWEEP_CRON = '*/15 * * * *';

/**
 * Five attempts in total, with exponential backoff (ADR-0006 D4).
 *
 * pg-boss counts *retries* in `retryLimit`: retryLimit 4 means the first attempt
 * plus four more. 60s doubling caps at roughly 16 minutes of retrying, which is
 * longer than a database failover and shorter than a human noticing.
 */
export const JOB_RETRY_OPTIONS = {
  retryLimit: 4,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/**
 * The settlement queues' policy: at most one job may be *queued* per
 * `singletonKey`, with no limit on how many may be active.
 *
 * `short` is the one policy that bounds the queued state independently of any
 * time window, so a sweep that runs twice before a worker picks the job up
 * cannot leave two settle jobs for the same slot (ADR-0006 D3).
 */
export const SETTLE_SLOT_QUEUE_POLICY = 'short' as const;

/**
 * Two slots at a time per process (ADR-0006 D3).
 *
 * The ceiling is YouTube Analytics' daily quota, not CPU: every settle job
 * spends quota, so the concurrency is what keeps a burst of sweeps from
 * exhausting a day's reads in an afternoon.
 */
export const SETTLE_SLOT_LOCAL_CONCURRENCY = 2;

/**
 * One settle job per slot per 900 s bucket - aligned to the epoch, so the
 * boundaries fall on :00/:15/:30/:45 UTC, the same cadence as the sweep.
 *
 * A send inside the bucket is suppressed by pg-boss and resolves `null`; that is
 * the throttle, not an error (ADR-0006 D3).
 */
export const SETTLE_SLOT_SINGLETON_SECONDS = 900;

/**
 * One close job per slot per 900 s bucket, aligned exactly like the settle
 * bucket so the close sweep cannot queue the same slot twice in a window.
 *
 * The keys are namespaced (`close:<slotId>` vs `settle:<slotId>`), so a close
 * job for a slot never suppresses or is suppressed by its settle job.
 */
export const CLOSE_SLOT_SINGLETON_SECONDS = 900;

/**
 * Ten minutes per attempt. A settle job makes one metrics call plus one short
 * Serializable transaction; anything approaching ten minutes is stuck, and the
 * retry is worth more than the wait. A close job makes the same final read, so
 * it uses the same budget.
 */
export const SETTLE_SLOT_EXPIRY_SECONDS = 600;
