// apps/worker/src/jobs/register.settlement.test.ts
//
// The settlement half of the queue wiring, without a database and without a
// pg-boss instance (ADR-0006 D2, D3, D4).
//
// What is asserted here is what an operator would notice if it were wrong:
// the queue's policy (the throttle), the local concurrency (the YouTube quota
// ceiling), the cron, the singleton send options, and the fact that a missing
// settleSlot dependency fails the job instead of completing it silently.

import type { PrismaClient } from '@repo/database';
import { SlotStatus } from '@repo/database';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { createRecordingLogger } from '../test-support/recording-logger';
import type { JobContext, JobDeps } from './context';
import { registerJobs } from './register';
import {
  DEAD_LETTER_QUEUE,
  JOB_RETRY_OPTIONS,
  SETTLE_SLOT_EXPIRY_SECONDS,
  SETTLE_SLOT_LOCAL_CONCURRENCY,
  SETTLE_SLOT_QUEUE,
  SETTLE_SLOT_QUEUE_POLICY,
  SETTLE_SLOT_SINGLETON_SECONDS,
  SETTLEMENT_SWEEP_CRON,
  SETTLEMENT_SWEEP_QUEUE,
} from './queues';

type Handler = (jobs: Array<{ id: string; data?: unknown }>) => Promise<unknown>;

interface WorkCall {
  name: string;
  options: unknown;
  handler: Handler;
}

function fakeBoss(sendResult: string | null = 'job-1'): {
  boss: PgBoss;
  queues: Array<{ name: string; options: unknown }>;
  schedules: Array<{ name: string; cron: string }>;
  works: WorkCall[];
  sends: Array<{ queue: string; data: unknown; options: unknown }>;
} {
  const queues: Array<{ name: string; options: unknown }> = [];
  const schedules: Array<{ name: string; cron: string }> = [];
  const works: WorkCall[] = [];
  const sends: Array<{ queue: string; data: unknown; options: unknown }> = [];

  const boss = {
    createQueue: async (name: string, options?: unknown) => {
      queues.push({ name, options });
    },
    schedule: async (name: string, cron: string) => {
      schedules.push({ name, cron });
    },
    work: async (name: string, optionsOrHandler: unknown, maybeHandler?: unknown) => {
      const options = typeof optionsOrHandler === 'function' ? undefined : optionsOrHandler;
      const handler = (
        typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler
      ) as Handler;
      works.push({ name, options, handler });
      return 'worker-id';
    },
    send: async (queue: string, data: unknown, options: unknown) => {
      sends.push({ queue, data, options });
      return sendResult;
    },
  } as unknown as PgBoss;

  return { boss, queues, schedules, works, sends };
}

const NOW = new Date('2026-11-16T12:00:00.000Z');

function context(slotRows: Array<{ id: string }> = []): {
  ctx: JobContext;
  recorder: ReturnType<typeof createRecordingLogger>;
} {
  const recorder = createRecordingLogger();

  const db = {
    campaignCreatorSlot: {
      findMany: vi.fn(async () => slotRows),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => ({
        status: SlotStatus.IN_PROGRESS,
        deletedAt: null,
        disputedAt: null,
        settlementEndsAt: new Date(NOW.getTime() + 60_000),
      })),
    },
  } as unknown as PrismaClient;

  return { ctx: { db, logger: recorder.logger, now: () => NOW }, recorder };
}

/** The settle handler only needs to know the slot was reached. */
function depsSpy(): { deps: JobDeps; settleSlot: ReturnType<typeof vi.fn> } {
  const settleSlot = vi.fn(async () => ({ status: 'NO_CHANGE' as const, reason: 'no_new_tiers' as const }));
  return { deps: { settleSlot }, settleSlot };
}

function handlerFor(works: WorkCall[], queue: string): WorkCall {
  const found = works.find((work) => work.name === queue);
  if (found === undefined) throw new Error(`no handler registered for ${queue}`);
  return found;
}

// ---------------------------------------------------------------------------
// Queues and schedules
// ---------------------------------------------------------------------------

describe('registerJobs settlement wiring', () => {
  it("creates the settle queue with the 'short' policy, a 600 s expiry and the dead-letter queue", async () => {
    const { boss, queues } = fakeBoss();
    const { ctx } = context();

    await registerJobs(boss, ctx, depsSpy().deps);

    const settle = queues.find((queue) => queue.name === SETTLE_SLOT_QUEUE);
    expect(settle).toBeDefined();
    expect(settle!.options).toMatchObject({
      policy: SETTLE_SLOT_QUEUE_POLICY,
      expireInSeconds: SETTLE_SLOT_EXPIRY_SECONDS,
      deadLetter: DEAD_LETTER_QUEUE,
      ...JOB_RETRY_OPTIONS,
    });
    // The literal matters: 'short' is what bounds the queued state per key.
    expect(SETTLE_SLOT_QUEUE_POLICY).toBe('short');
    expect(SETTLE_SLOT_EXPIRY_SECONDS).toBe(600);
  });

  it('registers the settlement queues after the invite queue and keeps the dead-letter queue first', async () => {
    const { boss, queues } = fakeBoss();
    const { ctx } = context();

    await registerJobs(boss, ctx, depsSpy().deps);

    expect(queues.map((queue) => queue.name)).toEqual([
      DEAD_LETTER_QUEUE,
      'invites.expire',
      SETTLEMENT_SWEEP_QUEUE,
      SETTLE_SLOT_QUEUE,
    ]);
  });

  it('schedules the settlement sweep every fifteen minutes', async () => {
    const { boss, schedules } = fakeBoss();
    const { ctx } = context();

    await registerJobs(boss, ctx, depsSpy().deps);

    expect(schedules).toContainEqual({ name: SETTLEMENT_SWEEP_QUEUE, cron: SETTLEMENT_SWEEP_CRON });
    expect(SETTLEMENT_SWEEP_CRON).toBe('*/15 * * * *');
  });

  it('runs the settle handler with local concurrency two', async () => {
    const { boss, works } = fakeBoss();
    const { ctx } = context();

    await registerJobs(boss, ctx, depsSpy().deps);

    expect(handlerFor(works, SETTLE_SLOT_QUEUE).options).toEqual({
      localConcurrency: SETTLE_SLOT_LOCAL_CONCURRENCY,
    });
    expect(SETTLE_SLOT_LOCAL_CONCURRENCY).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

describe('settlement handlers', () => {
  it('settles the slot named by a valid job', async () => {
    const { boss, works } = fakeBoss();
    const { ctx } = context();
    const { deps, settleSlot } = depsSpy();

    await registerJobs(boss, ctx, deps);
    await handlerFor(works, SETTLE_SLOT_QUEUE).handler([{ id: 'job-1', data: { slotId: 'slot_abc' } }]);

    expect(settleSlot).toHaveBeenCalledWith('slot_abc', ctx.db);
  });

  it('refuses an invalid job payload without calling settleSlot', async () => {
    const { boss, works } = fakeBoss();
    const { ctx, recorder } = context();
    const { deps, settleSlot } = depsSpy();

    await registerJobs(boss, ctx, deps);
    await handlerFor(works, SETTLE_SLOT_QUEUE).handler([{ id: 'job-1', data: {} }]);

    expect(settleSlot).not.toHaveBeenCalled();
    const logged = recorder.at('error').find((entry) => entry.msg.includes('invalid job data'));
    expect(logged).toBeDefined();
    // The payload is not logged: only the queue and the job's own id.
    expect(Object.keys(logged!.fields).sort()).toEqual(['jobId', 'queue']);
  });

  it('fails the job when settleSlot is not bound, rather than completing it', async () => {
    const { boss, works } = fakeBoss();
    const { ctx } = context();

    await registerJobs(boss, ctx, {});
    await expect(
      handlerFor(works, SETTLE_SLOT_QUEUE).handler([{ id: 'job-1', data: { slotId: 'slot_abc' } }]),
    ).rejects.toThrow(/not bound/);
  });

  it('enqueues with the per-slot singleton key and the 900 s bucket', async () => {
    const { boss, works, sends } = fakeBoss();
    const { ctx } = context([{ id: 'slot_1' }]);

    await registerJobs(boss, ctx, depsSpy().deps);
    await handlerFor(works, SETTLEMENT_SWEEP_QUEUE).handler([]);

    expect(sends).toEqual([
      {
        queue: SETTLE_SLOT_QUEUE,
        data: { slotId: 'slot_1' },
        options: { singletonKey: 'settle:slot_1', singletonSeconds: SETTLE_SLOT_SINGLETON_SECONDS },
      },
    ]);
    expect(SETTLE_SLOT_SINGLETON_SECONDS).toBe(900);
  });

  it('counts a suppressed send separately from an inserted one', async () => {
    const { boss, works } = fakeBoss(null);
    const { ctx, recorder } = context([{ id: 'slot_1' }]);

    await registerJobs(boss, ctx, depsSpy().deps);
    await handlerFor(works, SETTLEMENT_SWEEP_QUEUE).handler([]);

    const finished = recorder.entries.find((entry) => entry.msg === 'job finished');
    expect(finished!.fields.summary).toEqual({
      scanned: 1,
      enqueued: 0,
      suppressed: 1,
      truncated: false,
    });
  });
});
