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

import type { JobWithMetadata, PgBoss } from 'pg-boss';

import { describeError } from '../errors';
import type { JobContext, JobDeps } from './context';
import { expireInvites } from './expire-invites';
import {
  DEAD_LETTER_QUEUE,
  INVITES_EXPIRE_CRON,
  INVITES_EXPIRE_QUEUE,
  JOB_RETRY_OPTIONS,
} from './queues';

/** What a dead-lettered job may carry. Stage 2 fills slotId in. */
interface DeadLetterData {
  slotId?: string;
}

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
    // `summary` is a job's counts (scanned/expired/truncated): numbers only, by
    // construction of every job function (R6).
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
 * Creates and starts the worker's queues and handlers. Called once, after
 * `boss.start()`, and only after configuration and the database are known good.
 *
 * @param deps - bound web-app dependencies (ADR-0006 D7). Stage 1 uses none.
 */
export async function registerJobs(boss: PgBoss, ctx: JobContext, deps: JobDeps): Promise<void> {
  // Stage 2 reads the settlement provider from `deps`; the invite sweeper needs
  // nothing from the web app, so Stage 1 only keeps the binding wired.
  void deps;

  // The dead-letter queue has to exist first: every other queue references it
  // through a foreign key, so createQueue on a queue that names a missing
  // dead-letter queue fails.
  //
  // createQueue is INSERT ... ON CONFLICT DO NOTHING, so running this on every
  // boot is safe and needs no migration of its own.
  await boss.createQueue(DEAD_LETTER_QUEUE);

  await boss.createQueue(INVITES_EXPIRE_QUEUE, {
    ...JOB_RETRY_OPTIONS,
    deadLetter: DEAD_LETTER_QUEUE,
  });

  // schedule() is idempotent for the same (name, cron) pair: pg-boss stores the
  // schedule row and updates it rather than adding a second cron entry.
  await boss.schedule(INVITES_EXPIRE_QUEUE, INVITES_EXPIRE_CRON);

  // One sweep per batch. Invite expiry is a bounded, idempotent pass over the
  // table, so ten queued cron ticks do not need ten passes; if the sweep throws,
  // every job in the batch retries and the next pass simply redoes the work.
  await boss.work(INVITES_EXPIRE_QUEUE, async () => {
    await runJob(INVITES_EXPIRE_QUEUE, ctx, () => expireInvites(ctx));
  });

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
