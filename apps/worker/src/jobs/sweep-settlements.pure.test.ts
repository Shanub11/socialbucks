// apps/worker/src/jobs/sweep-settlements.pure.test.ts
//
// The sweep without a database: the slot table is a stub that records the query
// it was handed and answers with fixed pages.
//
// The real-DB suite proves what Postgres does with the query; this file proves
// what the sweep ASKS for, and the two properties that no assertion about counts
// can catch:
//
//   1. the order. Nothing carries progress between runs, so `lastViewCheckAt ASC
//      NULLS FIRST, id ASC` is the only reason a second run reaches the slots the
//      first one's budget cut off. If it silently degraded to `id`, every count
//      below would still pass and the sweep would starve the tail;
//   2. it writes nothing. The sweep enqueues; a stray update here would be a job
//      mutating slots it never settled (R3).
//
// The stub's write methods record instead of throwing, because a recorded write
// makes the assertion read "the sweep wrote X" rather than a stack trace.

import type { PrismaClient } from '@repo/database';
import { SlotStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';

import { createRecordingLogger } from '../test-support/recording-logger';
import type { Enqueue, EnqueueContext } from './context';
import { SETTLE_SLOT_QUEUE, SETTLE_SLOT_SINGLETON_SECONDS } from './queues';
import { sweepSettlements } from './sweep-settlements';

const NOW = new Date('2026-11-16T12:00:00.000Z');

/** The order the sweep must ask for, spelled out rather than imported. */
const EXPECTED_ORDER_BY = [
  { lastViewCheckAt: { sort: 'asc', nulls: 'first' } },
  { id: 'asc' },
];

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
 *
 * A call past the last page answers with an empty page, which is what a real
 * query does when the offset is beyond the end.
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

describe('sweepSettlements query', () => {
  it('selects exactly the ADR-0006 D3 predicate, with no extra clause', async () => {
    const stub = stubDb([[]]);
    const { enqueue } = recordingEnqueue();

    await sweepSettlements(context(stub.db, enqueue).ctx);

    expect(stub.reads[0]!.where).toEqual({
      status: SlotStatus.IN_PROGRESS,
      deletedAt: null,
      settlementEndsAt: { gt: NOW },
    });
    // Exactly three clauses: a fourth filter would be a policy change, not a
    // performance tweak.
    expect(Object.keys(stub.reads[0]!.where as Record<string, unknown>)).toHaveLength(3);
    // The window is compared against the injected clock, not a literal.
    expect(
      (stub.reads[0]!.where as { settlementEndsAt: { gt: Date } }).settlementEndsAt.gt,
    ).toBe(NOW);
  });

  it('never selects a column beyond the id', async () => {
    const stub = stubDb([[]]);
    const { enqueue } = recordingEnqueue();

    await sweepSettlements(context(stub.db, enqueue).ctx);

    expect(stub.reads[0]!.select).toEqual({ id: true });
  });

  it('orders never-read slots first, then the oldest read, then by id', async () => {
    const stub = stubDb([[]]);
    const { enqueue } = recordingEnqueue();

    await sweepSettlements(context(stub.db, enqueue).ctx);

    expect(stub.reads[0]!.orderBy).toEqual(EXPECTED_ORDER_BY);
    // `nulls: 'first'` is the clause that makes a never-read slot sort ahead of
    // a read one; without it Postgres puts NULLs last and the sweep starves the
    // unread tail instead.
    expect(
      (stub.reads[0]!.orderBy as Array<{ lastViewCheckAt?: { nulls?: string } }>)[0]
        ?.lastViewCheckAt?.nulls,
    ).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// How it pages, and when it says it was cut off
// ---------------------------------------------------------------------------

describe('sweepSettlements batching', () => {
  it('pages skip/take to the cap, then asks for exactly one row past it', async () => {
    // batchSize 2 x maxBatches 2 = a cap of 4. Two full pages fill it; the third
    // read is the truncation probe, and it returns nothing: no backlog.
    const stub = stubDb([pageOf('slot_a', 'slot_b'), pageOf('slot_c', 'slot_d'), []]);
    const { enqueue, sent } = recordingEnqueue();

    const summary = await sweepSettlements(context(stub.db, enqueue).ctx, {
      batchSize: 2,
      maxBatches: 2,
    });

    expect(stub.reads.map((read) => [read.skip, read.take])).toEqual([
      [0, 2],
      [2, 2],
      [4, 1],
    ]);
    // The probe asks for the same rows the pages did: the predicate and, more
    // importantly, the order must be identical or `truncated` is a lie.
    for (const read of stub.reads) {
      expect(read.orderBy).toEqual(EXPECTED_ORDER_BY);
      expect(read.where).toEqual({
        status: SlotStatus.IN_PROGRESS,
        deletedAt: null,
        settlementEndsAt: { gt: NOW },
      });
    }

    expect(sent).toHaveLength(4);
    expect(summary).toEqual({ scanned: 4, enqueued: 4, suppressed: 0, truncated: false });
  });

  it('reports truncated and warns with counts and the cap when a row is waiting', async () => {
    const stub = stubDb([pageOf('slot_a', 'slot_b'), pageOf('slot_c', 'slot_d'), pageOf('slot_e')]);
    const { enqueue } = recordingEnqueue();
    const { ctx, recorder } = context(stub.db, enqueue);

    const summary = await sweepSettlements(ctx, { batchSize: 2, maxBatches: 2 });

    expect(summary).toEqual({ scanned: 4, enqueued: 4, suppressed: 0, truncated: true });

    const warnings = recorder.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toEqual({ scanned: 4, enqueued: 4, suppressed: 0, cap: 4 });
    // Counts and the cap only - no slot id may ride along (R6).
    expect(JSON.stringify(warnings[0]!.fields)).not.toContain('slot_');
  });

  it('does not probe when the last page came up short', async () => {
    // A short page is proof of exhaustion on its own: no fifth read.
    const stub = stubDb([pageOf('slot_a')]);
    const { enqueue } = recordingEnqueue();

    const summary = await sweepSettlements(context(stub.db, enqueue).ctx, {
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

    await sweepSettlements(ctx, { batchSize: 10, maxBatches: 1 });

    expect(recorder.at('warn')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sends and writes
// ---------------------------------------------------------------------------

describe('sweepSettlements side effects', () => {
  it('counts a suppressed send as suppressed, never as enqueued', async () => {
    const stub = stubDb([pageOf('slot_a', 'slot_b')]);
    const { enqueue } = recordingEnqueue((slotId) => (slotId === 'slot_a' ? null : 'job_b'));
    const { ctx, recorder } = context(stub.db, enqueue);

    const summary = await sweepSettlements(ctx);

    expect(summary).toEqual({ scanned: 2, enqueued: 1, suppressed: 1, truncated: false });
    // Suppression is the throttle working, not a warning.
    expect(recorder.at('warn')).toHaveLength(0);
    expect(recorder.at('debug')[0]!.fields).toEqual({ scanned: 2, enqueued: 1, suppressed: 1 });
    expect(JSON.stringify(recorder.at('debug')[0]!.fields)).not.toContain('slot_');
  });

  it('sends the per-slot singleton key and the 900 s bucket', async () => {
    const stub = stubDb([pageOf('slot_a')]);
    const { enqueue, sent } = recordingEnqueue();

    await sweepSettlements(context(stub.db, enqueue).ctx);

    expect(sent).toEqual([
      {
        queue: SETTLE_SLOT_QUEUE,
        data: { slotId: 'slot_a' },
        options: { singletonKey: 'settle:slot_a', singletonSeconds: 900 },
      },
    ]);
    expect(SETTLE_SLOT_SINGLETON_SECONDS).toBe(900);
  });

  it('issues no write at all, even on a truncated run', async () => {
    const stub = stubDb([pageOf('slot_a', 'slot_b'), pageOf('slot_c')]);
    const { enqueue } = recordingEnqueue();

    const summary = await sweepSettlements(context(stub.db, enqueue).ctx, {
      batchSize: 2,
      maxBatches: 1,
    });

    expect(summary.truncated).toBe(true);
    // The sweep hands work off; it never marks, updates or deletes a slot. A
    // write here would be the worker settling a slot it did not settle.
    expect(stub.writes).toEqual([]);
  });
});
