// apps/worker/src/jobs/register.ts
//
// Where the job functions meet pg-boss (ADR-0006 D2, D3, D4).
//
// Three jobs for this file:
//   1. create the queues, dead-letter queue first;
//   2. install the cron schedules;
//   3. wrap every handler in the same start/finish/failure logging.
//
// The wrapper is the only place a job's failure becomes a log line and a retry.
// It logs the queue, the duration and `describeError` (name plus code) and never
// the message - see errors.ts for why.
//
// This module is loaded with a dynamic import() from main.ts: it value-imports
// expire-invites.ts, which value-imports the database client, and R10 keeps that
// out of main.ts's static graph.

import type { Job, JobWithMetadata, PgBoss } from 'pg-boss';
import { z } from 'zod';

import { describeError } from '../errors';
import type { Enqueue, EnqueueContext, JobContext, JobDeps } from './context';
import { expireInvites } from './expire-invites';
import { settleOne } from './settle-slot';
import { sweepSettlements } from './sweep-settlements';
import {
  DEAD_LETTER_QUEUE,
  INVITES_EXPIRE_CRON,
  INVITES_EXPIRE_QUEUE,
  JOB_RETRY_OPTIONS,
  SETTLE_SLOT_EXPIRY_SECONDS,
  SETTLE_SLOT_LOCAL_CONCURRENCY,
  SETTLE_SLOT_QUEUE,
  SETTLE_SLOT_QUEUE_POLICY,
  SETTLEMENT_SWEEP_CRON,
  SETTLEMENT_SWEEP_QUEUE,
} from './queues';

/** What a dead-lettered job may carry. */
interface DeadLetterData {
  slotId?: string;
}

/**
 * Job data is `{ slotId }` and nothing else (R8, ADR-0006 constraint 10).
 *
 * The schema is applied on the way in, not trusted: pg-boss stores whatever the
 * producer sent, and the producer of a settle job is a sweep that may be a
 * different replica on an older version of this code.
 */
const slotJobSchema = z.object({ slotId: z.string().min(1) });

type JobTask = () => Promise<unknown>;

/**
 * Runs one job function and turns it into the three log lines an operator needs:
 * started, finished with a summary, or failed with a name and a code.
 *
 * A failure is rethrown on purpose (ADR-0006 D4): pg-boss owns the retry and the
 * dead-letter decision, and a swallowed error would silently drop the work.
 */
async function runJob(queue: string, ctx: JobContext, task: JobTask): Promise<void> {
  const startedAt = Date.now();
  ctx.logger.debug('job started', { queue });

  try {
    const summary = await task();
    // `summary` is a job's counts (scanned/enqueued/suppressed/truncated, or an
    // outcome code): numbers and codes only, by construction of every job
    // function (R6).
    ctx.logger.info('job finished', {
      queue,
      durationMs: Date.now() - startedAt,
      summary,
    });
  } catch (error) {
    ctx.logger.error('job failed', {
      queue,
      durationMs: Date.now() - startedAt,
      ...describeError(error),
    });
    throw error;
  }
}

/**
 * Binds pg-boss's send to the shape a job may use.
 *
 * This is here, and not in the job files, because a job function never imports
 * pg-boss (R1): the sweeper receives `enqueue` and does not know what is behind
 * it. `send` resolves null when the queue's policy or the singleton bucket
 * suppressed the insert, which is exactly the signal the sweep counts.
 */
function createEnqueue(boss: PgBoss): Enqueue {
  return (queue, data, options) => boss.send(queue, data, options);
}

/**
 * Creates and starts the worker's queues and handlers. Called once, after
 * `boss.start()`, and only after configuration, the settlement environment and
 * the database are known good.
 *
 * @param deps - bound web-app dependencies (ADR-0006 D5, D7). `buildDeps()`
 *   always binds `settleSlot`; main.ts refuses to start if it does not.
 */
export async function registerJobs(boss: PgBoss, ctx: JobContext, deps: JobDeps): Promise<void> {
  // The dead-letter queue has to exist first: every other queue references it
  // through a foreign key, so createQueue on a queue that names a missing
  // dead-letter queue fails.
  //
  // createQueue is INSERT ... ON CONFLICT DO NOTHING, so running this on every
  // boot is safe and needs no migration of its own - but it also means a policy
  // changed here is NOT applied to a queue that already exists; that needs
  // updateQueue (ADR-0006 D3).
  await boss.createQueue(DEAD_LETTER_QUEUE);

  await boss.createQueue(INVITES_EXPIRE_QUEUE, {
    ...JOB_RETRY_OPTIONS,
    deadLetter: DEAD_LETTER_QUEUE,
  });

  // The sweep itself writes nothing, so it needs no singleton options: it is a
  // bounded, idempotent pass, and two overlapping sweeps are two passes.
  await boss.createQueue(SETTLEMENT_SWEEP_QUEUE, {
    ...JOB_RETRY_OPTIONS,
    deadLetter: DEAD_LETTER_QUEUE,
  });

  // One slot, one read. `short` bounds the queued jobs per singleton key, and
  // `expireInSeconds` keeps a stuck provider call from holding a worker slot.
  await boss.createQueue(SETTLE_SLOT_QUEUE, {
    ...JOB_RETRY_OPTIONS,
    deadLetter: DEAD_LETTER_QUEUE,
    policy: SETTLE_SLOT_QUEUE_POLICY,
    expireInSeconds: SETTLE_SLOT_EXPIRY_SECONDS,
  });

  // schedule() is idempotent for the same (name, cron) pair: pg-boss stores the
  // schedule row and updates it rather than adding a second cron entry.
  await boss.schedule(INVITES_EXPIRE_QUEUE, INVITES_EXPIRE_CRON);
  await boss.schedule(SETTLEMENT_SWEEP_QUEUE, SETTLEMENT_SWEEP_CRON);

  // One sweep per batch. Invite expiry is a bounded, idempotent pass over the
  // table, so ten queued cron ticks do not need ten passes; if the sweep throws,
  // every job in the batch retries and the next pass simply redoes the work.
  //
  // The handler receives one job per call by default; it does not batch.
  await boss.work(INVITES_EXPIRE_QUEUE, async () => {
    await runJob(INVITES_EXPIRE_QUEUE, ctx, () => expireInvites(ctx));
  });

  // The sweeper needs a send, and pg-boss owns it. Binding it here keeps
  // sweep-settlements.ts free of pg-boss (R1).
  const enqueueContext: EnqueueContext = { ...ctx, enqueue: createEnqueue(boss) };

  await boss.work(SETTLEMENT_SWEEP_QUEUE, async () => {
    await runJob(SETTLEMENT_SWEEP_QUEUE, ctx, () => sweepSettlements(enqueueContext));
  });

  // Two slots at a time per process (ADR-0006 D3): the ceiling is the YouTube
  // Analytics quota, not CPU.
  await boss.work(
    SETTLE_SLOT_QUEUE,
    { localConcurrency: SETTLE_SLOT_LOCAL_CONCURRENCY },
    async (jobs: Job<{ slotId?: string }>[]) => {
      for (const job of jobs) {
        const parsed = slotJobSchema.safeParse(job.data);

        if (!parsed.success) {
          // Not retryable: the payload will never become valid. Log the queue
          // and the job's own name, never the payload.
          ctx.logger.error('settlement.settle-slot: invalid job data', {
            queue: SETTLE_SLOT_QUEUE,
            jobId: job.id,
          });
          continue;
        }

        await runJob(SETTLE_SLOT_QUEUE, ctx, () => settleOne(ctx, deps, parsed.data.slotId));
      }
    },
  );

  // Dead-letter handler (ADR-0006 D4): the last thing a permanently failed job
  // does is leave one line saying which queue gave up and on which slot.
  //
  // The copy that lands here is named after the dead-letter queue itself; the
  // queue it originally failed on is `sourceName`, which is only present with
  // includeMetadata: true.
  await boss.work(
    DEAD_LETTER_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<DeadLetterData>[]) => {
      for (const job of jobs) {
        ctx.logger.error('job dead-lettered', {
          queue: job.sourceName ?? DEAD_LETTER_QUEUE,
          slotId: job.data?.slotId,
        });
      }
    },
  );
}
