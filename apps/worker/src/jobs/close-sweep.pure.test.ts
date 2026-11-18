// apps/worker/src/jobs/close-sweep.pure.test.ts
//
// The close sweep without a database: the slot table is a stub that records the
// query it was handed and answers with fixed pages.
//
// The real-DB suite proves what Postgres does with the query; this file proves
// what the sweep ASKS for:
//
//   1. the predicate is the exact complement of the settle sweep's
//      (`settlementEndsAt <= now`, not `> now`), and it does NOT add a
//      `not: null` clause: `lte` is a comparison, and a comparison never matches
//      NULL, so a slot with no window is selected by neither sweep. Pinning the
//      where clause here keeps that a fact about SQL rather than a comment;
//   2. the order, so a slot a run's budget cut off leads the next run;
//   3. it writes nothing. The sweep enqueues; closing is the close job's job.

import type { PrismaClient } from '@repo/database';
import { SlotStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';

import { createRecordingLogger } from '../test-support/recording-logger';
import type { Enqueue, EnqueueContext } from './context';
import { closeSweep } from './close-sweep';
import { CLOSE_SLOT_QUEUE, CLOSE_SLOT_SINGLETON_SECONDS } from './queues';

const NOW = new Date('2026-11-16T12:00:00.000Z');

/** The order the sweep must ask for, spelled out rather than imported. */
const EXPECTED_ORDER_BY = [{ settlementEndsAt: 'asc' }, { id: 'asc' }];

interface FindManyArgs {
  where: unknown;
  orderBy: unknown;
  skip: number;
  take: number;
  select: unknown;
}

interface StubDb {
  db: PrismaClient;
  reads: FindManyArgs[];
  writes: string[];
}

/**
 * A slot table that answers with `pages` in order and records everything else.
 * A call past the last page answers with an empty page.
 */
function stubDb(pages: Array<Array<{ id: string }>>): StubDb {
  const reads: FindManyArgs[] = [];
  const writes: string[] = [];
  let pageIndex = 0;

  const write =
    (name: string) =>
    async (): Promise<unknown> => {
      writes.push(name);
      return { count: 0 };
    };

  const db = {
    campaignCreatorSlot: {
      findMany: async (args: FindManyArgs) => {
        reads.push(args);
        const page = pages[pageIndex] ?? [];
        pageIndex += 1;
        return page;
      },
      count: write('count'),
      create: write('create'),
      createMany: write('createMany'),
      update: write('update'),
      updateMany: write('updateMany'),
      delete: write('delete'),
      deleteMany: write('deleteMany'),
      upsert: write('upsert'),
    },
  } as unknown as PrismaClient;

  return { db, reads, writes };
}

interface Sent {
  queue: string;
  data: { slotId: string };
  options: { singletonKey: string; singletonSeconds: number };
}

function recordingEnqueue(inserted: (slotId: string) => string | null = (id) => `job_${id}`): {
  enqueue: Enqueue;
  sent: Sent[];
} {
  const sent: Sent[] = [];

  return {
    sent,
    enqueue: async (queue, data, options) => {
      sent.push({ queue, data, options });
      return inserted(data.slotId);
    },
  };
}

function context(db: PrismaClient, enqueue: Enqueue): {
  ctx: EnqueueContext;
  recorder: ReturnType<typeof createRecordingLogger>;
} {
  const recorder = createRecordingLogger();
  return { ctx: { db, logger: recorder.logger, now: () => NOW, enqueue }, recorder };
}

const pageOf = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }));

// ---------------------------------------------------------------------------
// What the sweep asks for
// ---------------------------------------------------------------------------

describe('closeSweep query', () => {
  it('selects exactly the ended-window predicate, with no extra clause', async () => {
    const stub = stubDb([[]]);
    const { enqueue } = recordingEnqueue();

    await closeSweep(context(stub.db, enqueue).ctx);

    expect(stub.reads[0]!.where).toEqual({
      status: SlotStatus.IN_PROGRESS,
      deletedAt: null,
      settlementEndsAt: { lte: NOW },
    });
    // Exactly three clauses: a fourth filter would be a policy change.
    expect(Object.keys(stub.reads[0]!.where as Record<string, unknown>)).toHaveLength(3);

    const window = (stub.reads[0]!.where as { settlementEndsAt: Record<string, unknown> })
      .settlementEndsAt;
    // The boundary: `lte`, not `lt`, and against the injected clock.
    expect(window.lte).toBe(NOW);
    // No `not: null`: `lte` already excludes NULL, which is what makes a slot
    // with no window belong to NEITHER sweep. A `not: null` here would still be
    // correct SQL, but it would suggest NULL needs handling at this layer.
    expect(Object.keys(window)).toEqual(['lte']);
  });

  it('never selects a column beyond the id', async () => {
    const stub = stubDb([[]]);
    const { enqueue } = recordingEnqueue();

    await closeSweep(context(stub.db, enqueue).ctx);

    expect(stub.reads[0]!.select).toEqual({ id: true });
  });

  it('orders by the oldest window first, then by id', async () => {
    const stub = stubDb([[]]);
    const { enqueue } = recordingEnqueue();

    await closeSweep(context(stub.db, enqueue).ctx);

    expect(stub.reads[0]!.orderBy).toEqual(EXPECTED_ORDER_BY);
  });
});

// ---------------------------------------------------------------------------
// How it pages, and when it says it was cut off
// ---------------------------------------------------------------------------

describe('closeSweep batching', () => {
  it('pages skip/take to the cap, then asks for exactly one row past it', async () => {
    const stub = stubDb([pageOf('slot_a', 'slot_b'), pageOf('slot_c', 'slot_d'), []]);
    const { enqueue, sent } = recordingEnqueue();

    const summary = await closeSweep(context(stub.db, enqueue).ctx, {
      batchSize: 2,
      maxBatches: 2,
    });

    expect(stub.reads.map((read) => [read.skip, read.take])).toEqual([
      [0, 2],
      [2, 2],
      [4, 1],
    ]);
    // The probe asks for the same rows the pages did: the predicate and the order
    // must be identical or `truncated` is a lie.
    for (const read of stub.reads) {
      expect(read.orderBy).toEqual(EXPECTED_ORDER_BY);
      expect(read.where).toEqual({
        status: SlotStatus.IN_PROGRESS,
        deletedAt: null,
        settlementEndsAt: { lte: NOW },
      });
    }

    expect(sent).toHaveLength(4);
    expect(summary).toEqual({ scanned: 4, enqueued: 4, suppressed: 0, truncated: false });
  });

  it('reports truncated and warns with counts and the cap when a row is waiting', async () => {
    const stub = stubDb([pageOf('slot_a', 'slot_b'), pageOf('slot_c', 'slot_d'), pageOf('slot_e')]);
    const { enqueue } = recordingEnqueue();
    const { ctx, recorder } = context(stub.db, enqueue);

    const summary = await closeSweep(ctx, { batchSize: 2, maxBatches: 2 });

    expect(summary).toEqual({ scanned: 4, enqueued: 4, suppressed: 0, truncated: true });

    const warnings = recorder.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toEqual({ scanned: 4, enqueued: 4, suppressed: 0, cap: 4 });
    // Counts and the cap only - no slot id may ride along (R6).
    expect(JSON.stringify(warnings[0]!.fields)).not.toContain('slot_');
  });

  it('does not probe when the last page came up short', async () => {
    const stub = stubDb([pageOf('slot_a')]);
    const { enqueue } = recordingEnqueue();

    const summary = await closeSweep(context(stub.db, enqueue).ctx, {
      batchSize: 2,
      maxBatches: 2,
    });

    expect(stub.reads).toHaveLength(1);
    expect(summary).toEqual({ scanned: 1, enqueued: 1, suppressed: 0, truncated: false });
  });

  it('is silent at warn when it drained the backlog', async () => {
    const stub = stubDb([pageOf('slot_a', 'slot_b', 'slot_c')]);
    const { enqueue } = recordingEnqueue();
    const { ctx, recorder } = context(stub.db, enqueue);

    await closeSweep(ctx, { batchSize: 10, maxBatches: 1 });

    expect(recorder.at('warn')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sends and writes
// ---------------------------------------------------------------------------

describe('closeSweep side effects', () => {
  it('counts a suppressed send as suppressed, never as enqueued', async () => {
    const stub = stubDb([pageOf('slot_a', 'slot_b')]);
    const { enqueue } = recordingEnqueue((slotId) => (slotId === 'slot_a' ? null : 'job_b'));
    const { ctx, recorder } = context(stub.db, enqueue);

    const summary = await closeSweep(ctx);

    expect(summary).toEqual({ scanned: 2, enqueued: 1, suppressed: 1, truncated: false });
    expect(recorder.at('warn')).toHaveLength(0);
    expect(recorder.at('debug')[0]!.fields).toEqual({ scanned: 2, enqueued: 1, suppressed: 1 });
    expect(JSON.stringify(recorder.at('debug')[0]!.fields)).not.toContain('slot_');
  });

  it('sends the per-slot close key, distinct from the settle key, and the 900 s bucket', async () => {
    const stub = stubDb([pageOf('slot_a')]);
    const { enqueue, sent } = recordingEnqueue();

    await closeSweep(context(stub.db, enqueue).ctx);

    expect(sent).toEqual([
      {
        queue: CLOSE_SLOT_QUEUE,
        data: { slotId: 'slot_a' },
        options: { singletonKey: 'close:slot_a', singletonSeconds: 900 },
      },
    ]);
    expect(CLOSE_SLOT_SINGLETON_SECONDS).toBe(900);
    // A close job must never share the settle job's key, or one would suppress
    // the other for fifteen minutes.
    expect(sent[0]!.options.singletonKey).not.toBe('settle:slot_a');
  });

  it('issues no write at all, even on a truncated run', async () => {
    const stub = stubDb([pageOf('slot_a', 'slot_b'), pageOf('slot_c')]);
    const { enqueue } = recordingEnqueue();

    const summary = await closeSweep(context(stub.db, enqueue).ctx, {
      batchSize: 2,
      maxBatches: 1,
    });

    expect(summary.truncated).toBe(true);
    // Closing is a state change with a CAS; a sweep that wrote here would be
    // closing slots it never read.
    expect(stub.writes).toEqual([]);
  });
});
