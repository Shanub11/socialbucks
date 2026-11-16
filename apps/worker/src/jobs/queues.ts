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
