// apps/worker/src/jobs/register.test.ts
//
// The queue wiring, without a database and without a pg-boss instance
// (ADR-0006 D2, D3, D4).
//
// A fake boss records exactly what registerJobs calls, in order - which is the
// only part of this module that is a decision. The handlers are captured and
// invoked, so the logging wrapper (durations, summaries, error names, the
// absence of error messages) is exercised as well.

import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '@repo/database';

import { createRecordingLogger } from '../test-support/recording-logger';
import type { JobContext, JobDeps } from './context';
import {
  CLOSE_SLOT_QUEUE,
  DEAD_LETTER_QUEUE,
  INVITES_EXPIRE_CRON,
  INVITES_EXPIRE_QUEUE,
  JOB_RETRY_OPTIONS,
  SETTLE_SLOT_QUEUE,
  SETTLEMENT_CLOSE_SWEEP_CRON,
  SETTLEMENT_CLOSE_SWEEP_QUEUE,
  SETTLEMENT_SWEEP_CRON,
  SETTLEMENT_SWEEP_QUEUE,
} from './queues';
import { registerJobs } from './register';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Handler = (jobs: unknown[]) => Promise<unknown>;

interface WorkCall {
  name: string;
  options: unknown;
  handler: Handler;
}

function fakeBoss(): {
  boss: PgBoss;
  queues: Array<{ name: string; options: unknown }>;
  schedules: Array<{ name: string; cron: string }>;
  works: WorkCall[];
} {
  const queues: Array<{ name: string; options: unknown }> = [];
  const schedules: Array<{ name: string; cron: string }> = [];
  const works: WorkCall[] = [];

  const boss = {
    createQueue: async (name: string, options?: unknown) => {
      queues.push({ name, options });
      return undefined;
    },
    schedule: async (name: string, cron: string) => {
      schedules.push({ name, cron });
      return undefined;
    },
    work: async (name: string, optionsOrHandler: unknown, maybeHandler?: unknown) => {
      // work(name, handler) for the sweeper, work(name, options, handler) for the
      // dead-letter queue, which needs job metadata.
      const options = typeof optionsOrHandler === 'function' ? undefined : optionsOrHandler;
      const handler = (typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler) as
        | Handler
        | undefined;
      if (handler === undefined) throw new Error('work() called without a handler');
      works.push({ name, options, handler });
      return 'worker-id';
    },
  } as unknown as PgBoss;

  return { boss, queues, schedules, works };
}

/** A client whose slot table answers only what a sweep asks of it. */
function stubDb(overrides: {
  findMany?: () => Promise<Array<{ id: string }>>;
  updateMany?: () => Promise<{ count: number }>;
}): PrismaClient {
  return {
    campaignCreatorSlot: {
      findMany: overrides.findMany ?? (async () => []),
      updateMany: overrides.updateMany ?? (async () => ({ count: 0 })),
    },
  } as unknown as PrismaClient;
}

const NO_DEPS: JobDeps = {};

function context(db: PrismaClient): { ctx: JobContext; recorder: ReturnType<typeof createRecordingLogger> } {
  const recorder = createRecordingLogger();
  return { ctx: { db, logger: recorder.logger, now: () => new Date('2026-11-16T12:00:00.000Z') }, recorder };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('registerJobs', () => {
  it('creates the dead-letter queue before the queues that point at it', async () => {
    const { boss, queues } = fakeBoss();

    await registerJobs(boss, context(stubDb({})).ctx, NO_DEPS);

    expect(queues.map((queue) => queue.name)).toEqual([
      DEAD_LETTER_QUEUE,
      INVITES_EXPIRE_QUEUE,
      SETTLEMENT_SWEEP_QUEUE,
      SETTLE_SLOT_QUEUE,
      SETTLEMENT_CLOSE_SWEEP_QUEUE,
      CLOSE_SLOT_QUEUE,
    ]);
    expect(queues[1]!.options).toMatchObject({
      deadLetter: DEAD_LETTER_QUEUE,
      ...JOB_RETRY_OPTIONS,
    });
  });

  it('schedules the invite sweeper every ten minutes', async () => {
    const { boss, schedules } = fakeBoss();

    await registerJobs(boss, context(stubDb({})).ctx, NO_DEPS);

    expect(schedules).toEqual([
      { name: INVITES_EXPIRE_QUEUE, cron: INVITES_EXPIRE_CRON },
      { name: SETTLEMENT_SWEEP_QUEUE, cron: SETTLEMENT_SWEEP_CRON },
      { name: SETTLEMENT_CLOSE_SWEEP_QUEUE, cron: SETTLEMENT_CLOSE_SWEEP_CRON },
    ]);
    expect(INVITES_EXPIRE_CRON).toBe('*/10 * * * *');
  });

  it('registers a sweeper handler and a dead-letter handler that reads job metadata', async () => {
    const { boss, works } = fakeBoss();

    await registerJobs(boss, context(stubDb({})).ctx, NO_DEPS);

    expect(works.map((work) => work.name)).toEqual([
      INVITES_EXPIRE_QUEUE,
      SETTLEMENT_SWEEP_QUEUE,
      SETTLE_SLOT_QUEUE,
      SETTLEMENT_CLOSE_SWEEP_QUEUE,
      CLOSE_SLOT_QUEUE,
      DEAD_LETTER_QUEUE,
    ]);
    // Metadata is the only way the dead-letter handler can learn the original queue,
    // and the dead-letter handler is registered last.
    expect(works[5]!.options).toEqual({ includeMetadata: true });
  });
});

// ---------------------------------------------------------------------------
// The logging wrapper
// ---------------------------------------------------------------------------

describe('job wrapper', () => {
  it('logs the sweep summary and the duration of a successful run', async () => {
    const { boss, works } = fakeBoss();
    const { ctx, recorder } = context(stubDb({}));

    await registerJobs(boss, ctx, NO_DEPS);
    await works[0]!.handler([]);

    const finished = recorder.entries.find((entry) => entry.msg === 'job finished');
    expect(finished?.level).toBe('info');
    expect(finished?.fields.queue).toBe(INVITES_EXPIRE_QUEUE);
    expect(finished?.fields.summary).toEqual({ scanned: 0, expired: 0, truncated: false });
    expect(typeof finished?.fields.durationMs).toBe('number');
  });

  it('logs a failure by name and code, never by message, and rethrows it', async () => {
    const canary = 'CANARY_do_not_log_7c1';
    const failure = Object.assign(new Error(`${canary}: connection failed for postgres://user:hunter2@host/db`), {
      code: 'P2002',
    });

    const { boss, works } = fakeBoss();
    const { ctx, recorder } = context(
      stubDb({
        findMany: async () => {
          throw failure;
        },
      }),
    );

    await registerJobs(boss, ctx, NO_DEPS);

    await expect(works[0]!.handler([])).rejects.toThrow(failure);

    const failed = recorder.entries.find((entry) => entry.msg === 'job failed');
    expect(failed?.level).toBe('error');
    expect(failed?.fields).toMatchObject({
      queue: INVITES_EXPIRE_QUEUE,
      errorName: 'Error',
      code: 'P2002',
    });

    // The whole record, not just the message field: no key may carry the message.
    expect(recorder.text()).not.toContain(canary);
    expect(recorder.text()).not.toContain('hunter2');
  });

  it('logs the original queue and the slot of a dead-lettered job', async () => {
    const { boss, works } = fakeBoss();
    const { ctx, recorder } = context(stubDb({}));

    await registerJobs(boss, ctx, NO_DEPS);

    await works[5]!.handler([
      {
        id: 'job-1',
        name: DEAD_LETTER_QUEUE,
        sourceName: SETTLE_SLOT_QUEUE,
        data: { slotId: 'slot_abc' },
      } as unknown as JobWithMetadata<{ slotId?: string }>,
    ]);

    const deadLettered = recorder.at('error').find((entry) => entry.msg === 'job dead-lettered');
    expect(deadLettered?.fields).toEqual({ queue: SETTLE_SLOT_QUEUE, slotId: 'slot_abc' });
  });
});
