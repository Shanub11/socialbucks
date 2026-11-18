// apps/worker/src/jobs/context.ts
//
// What a job function is allowed to reach: a database client, a logger and a
// clock. Nothing else is in scope, which is what makes a job testable without a
// process, a queue or a system clock (ADR-0006 R7).
//
// The client is a parameter, not an import. Two consequences matter:
//   - a job test can hand in a Proxy over the real client to force a race, and
//   - nothing below this file decides which database it talks to.
//
// `import type` only: this file must stay loadable without creating the Prisma
// singleton, and R10 keeps it out of main.ts's static graph.

import type { PrismaClient } from '@repo/database';

import type { SettleOutcome } from '@/lib/settlement/settle-slot';
import type { Logger } from '../logger';

/** Injected clock. A job never calls Date.now() on its own (R7). */
export type Clock = () => Date;

export interface JobContext {
  db: PrismaClient;
  logger: Logger;
  now: Clock;
}

/**
 * What `send` returned: the pg-boss job id when a row was inserted, or null when
 * the send was suppressed.
 *
 * pg-boss suppresses a send by not inserting (ON CONFLICT DO NOTHING) and
 * resolving null - it is not an error, and a sweeper must not count it as work
 * it handed off.
 */
export type EnqueueResult = string | null;

/**
 * The send options a per-slot job uses. `singletonKey` identifies the slot;
 * `singletonSeconds` puts the send in a time bucket so the same key cannot be
 * queued twice inside it (ADR-0006 D3).
 */
export interface EnqueueOptions {
  singletonKey: string;
  singletonSeconds: number;
}

/** A pg-boss send, bound in register.ts so no job file imports pg-boss (R1). */
export type Enqueue = (
  queue: string,
  data: { slotId: string },
  options: EnqueueOptions,
) => Promise<EnqueueResult>;

/**
 * A context that can hand work to another queue. Only the sweepers need this:
 * the jobs they enqueue read the database themselves.
 */
export interface EnqueueContext extends JobContext {
  enqueue: Enqueue;
}

/**
 * `settleSlot` as the worker binds it: the database client is already the
 * worker's own, so the job passes only what changes per call (ADR-0006 D5).
 */
export type SettleSlotFn = (slotId: string, db: PrismaClient) => Promise<SettleOutcome>;

/**
 * The web app's settlement code, bound once at startup (ADR-0006 D5, D7).
 *
 * Optional in the type so a unit test can build a context without the web app,
 * but `buildDeps()` always binds it and `main.ts` refuses to start without it:
 * a missing binding is a startup failure, never a worker that accepts
 * settlement work and silently does nothing with it.
 */
export interface JobDeps {
  settleSlot?: SettleSlotFn;
}
