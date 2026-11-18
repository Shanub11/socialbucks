// apps/worker/src/jobs/sweep-settlements.test.ts
//
// Real database tests for the settlement sweep (ADR-0006 D3).
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the database is unreachable, the
// suite FAILS LOUDLY - it never silently skips.
//
// The sweeps select the whole table, so this file resets the slot tables once in
// beforeAll: a row left behind by a killed run or by the web suite would change
// `scanned` for a test that only created three slots. Per-test cleanup stays by
// id, as fixtures.ts does.
//
// Assertions are on this suite's own fixture ids - the enqueued ids restricted to
// this test's slots - except in the batch-cap test, which is about whole-table
// counts and relies on the reset.

import { prisma, SlotStatus } from '@repo/database';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createCampaignWithInvites,
  removeFixture,
  type CampaignFixture,
} from '../test-support/fixtures';
import { createRecordingLogger } from '../test-support/recording-logger';
import { resetSlotTables } from '../test-support/reset-test-db';
import type { Enqueue, EnqueueContext } from './context';
import { SETTLE_SLOT_QUEUE, SETTLE_SLOT_SINGLETON_SECONDS } from './queues';
import { sweepSettlements } from './sweep-settlements';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

if (!RUN_DB_TESTS) {
  console.warn(
    '[jobs/sweep-settlements.test] RUN_DB_TESTS != 1 - the settlement sweep tests are SKIPPED, not passing.',
  );
}

if (RUN_DB_TESTS && !process.env.TEST_DATABASE_URL) {
  throw new Error('[jobs/sweep-settlements.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.');
}

if (RUN_DB_TESTS && process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
  throw new Error(
    '[jobs/sweep-settlements.test] DATABASE_URL and TEST_DATABASE_URL must be the same database.',
  );
}

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

const NOW = new Date('2026-11-16T12:00:00.000Z');
const SECOND = 1_000;

function windowIn(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

interface Sent {
  queue: string;
  data: { slotId: string };
  options: { singletonKey: string; singletonSeconds: number };
}

/** Records every send; `inserted` decides what pg-boss would have answered. */
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

function context(enqueue: Enqueue): {
  ctx: EnqueueContext;
  recorder: ReturnType<typeof createRecordingLogger>;
} {
  const recorder = createRecordingLogger();
  return { ctx: { db: prisma, logger: recorder.logger, now: () => NOW, enqueue }, recorder };
}

describeDb('sweepSettlements (real DB)', () => {
  const created: CampaignFixture[] = [];

  beforeAll(async () => {
    await resetSlotTables(prisma);
  });

  afterEach(async () => {
    const pending = created.splice(0).reverse();
    for (const fixture of pending) {
      await removeFixture(fixture);
    }
  });

  async function fixture(
    options?: Parameters<typeof createCampaignWithInvites>[0],
  ): Promise<CampaignFixture> {
    const made = await createCampaignWithInvites(options);
    created.push(made);
    return made;
  }

  /** fixtures.ts does not model the window, so the test sets it explicitly. */
  async function setWindow(
    slotIds: string[],
    settlementEndsAt: Date | null,
    extra: { deletedAt?: Date } = {},
  ): Promise<void> {
    await prisma.campaignCreatorSlot.updateMany({
      where: { id: { in: slotIds } },
      data: { settlementEndsAt, ...extra },
    });
  }

  /**
   * An IN_PROGRESS slot: the only state the sweep selects.
   *
   * `createCampaignWithInvites` defaults to INVITED, and a sweep that finds
   * nothing says so only as `scanned: 0` - which is why every test that means
   * "an open slot" has to ask for this state explicitly, and why
   * `expectSlotState` reads it back afterwards.
   */
  async function openSlotFixture(count = 1): Promise<CampaignFixture> {
    return fixture({ count, status: SlotStatus.IN_PROGRESS });
  }

  /**
   * Builds a DISPUTED slot the way the app does: an IN_PROGRESS slot, then a
   * transition. It cannot be inserted directly - `slot_disputed_requires_record`
   * needs the dispute columns, and `slot_status_transition_guard` only allows
   * DISPUTED out of IN_PROGRESS.
   */
  async function makeDisputed(made: CampaignFixture, raisedByUserId: string): Promise<void> {
    await prisma.campaignCreatorSlot.update({
      where: { id: made.slotIds[0]! },
      data: {
        status: SlotStatus.DISPUTED,
        disputedAt: new Date(NOW.getTime() - 60 * SECOND),
        disputeReason: 'worker fixture dispute',
        disputeRaisedByUserId: raisedByUserId,
      },
    });
  }

  /**
   * Builds a CLOSED slot the same way: `slot_closed_requires_closed_at` needs
   * `closedAt`, and the guard only allows CLOSED from IN_PROGRESS or DISPUTED.
   */
  async function makeClosed(made: CampaignFixture): Promise<void> {
    await prisma.campaignCreatorSlot.update({
      where: { id: made.slotIds[0]! },
      data: {
        status: SlotStatus.CLOSED,
        closedAt: new Date(NOW.getTime() - 60 * SECOND),
      },
    });
  }

  interface SlotExpectation {
    /** What this row is for, so a failure reads as "the fixture", not the sweep. */
    role: string;
    slotIds: string[];
    status: SlotStatus;
    settlementEndsAt: Date | null;
    /** Omitted means "not soft-deleted". */
    deletedAt?: Date | null;
  }

  /**
   * Reads the rows back and asserts the state the test intended to build.
   *
   * A fixture left at its INVITED default, or with a NULL window, otherwise
   * fails as `scanned: 0` - which reads like a bug in the sweep. Here it fails
   * as what it is: a slot that is not in the state the case is about.
   */
  async function expectSlotState(expectations: SlotExpectation[]): Promise<void> {
    for (const expected of expectations) {
      const rows = await prisma.campaignCreatorSlot.findMany({
        where: { id: { in: expected.slotIds } },
        select: { id: true, status: true, deletedAt: true, settlementEndsAt: true },
      });

      expect(rows, `${expected.role}: expected ${expected.slotIds.length} slot(s)`).toHaveLength(
        expected.slotIds.length,
      );

      for (const row of rows) {
        expect(row.status, `${expected.role}: slot ${row.id} status`).toBe(expected.status);
        expect(
          row.settlementEndsAt?.getTime() ?? null,
          `${expected.role}: slot ${row.id} settlementEndsAt`,
        ).toBe(expected.settlementEndsAt?.getTime() ?? null);
        expect(
          row.deletedAt?.getTime() ?? null,
          `${expected.role}: slot ${row.id} deletedAt`,
        ).toBe(expected.deletedAt?.getTime() ?? null);
      }
    }
  }

  it('enqueues only IN_PROGRESS, non-deleted slots whose window is open', async () => {
    // Statuses that can be inserted in one statement: no CHECK constraint needs
    // an extra column for them, and the transition trigger fires on UPDATE only.
    const simpleStatuses = [
      SlotStatus.INVITED,
      SlotStatus.ACCEPTED,
      SlotStatus.CONTENT_SUBMITTED,
      SlotStatus.CONTENT_APPROVED,
      SlotStatus.IN_PROGRESS,
      SlotStatus.COMPLETED,
      SlotStatus.CANCELLED,
      SlotStatus.DECLINED,
      SlotStatus.EXPIRED,
    ] as const;

    const byStatus = new Map<SlotStatus, CampaignFixture>();
    for (const status of simpleStatuses) {
      byStatus.set(status, await fixture({ status }));
    }

    // DISPUTED and CLOSED cannot be inserted directly: one needs the dispute
    // record, the other needs closedAt, and the guard only allows both as a
    // transition out of IN_PROGRESS. Build them the way the app does.
    const disputed = await openSlotFixture();
    await makeDisputed(disputed, disputed.userIds[0]!);
    const closed = await openSlotFixture();
    await makeClosed(closed);

    const everySlot = [...byStatus.values(), disputed, closed].flatMap((made) => made.slotIds);
    const window = windowIn(60 * SECOND);
    await setWindow(everySlot, window);

    const expectations: SlotExpectation[] = [
      ...simpleStatuses.map((status) => ({
        role: `${status} slot`,
        slotIds: byStatus.get(status)!.slotIds,
        status,
        settlementEndsAt: window,
      })),
      {
        role: 'DISPUTED slot',
        slotIds: disputed.slotIds,
        status: SlotStatus.DISPUTED,
        settlementEndsAt: window,
      },
      {
        role: 'CLOSED slot',
        slotIds: closed.slotIds,
        status: SlotStatus.CLOSED,
        settlementEndsAt: window,
      },
    ];
    await expectSlotState(expectations);

    const inProgress = byStatus.get(SlotStatus.IN_PROGRESS)!.slotIds;

    const { enqueue, sent } = recordingEnqueue();
    const summary = await sweepSettlements(context(enqueue).ctx);

    const enqueuedIds = sent
      .map((entry) => entry.data.slotId)
      .filter((id) => everySlot.includes(id));

    expect(new Set(enqueuedIds)).toEqual(new Set(inProgress));
    // No excluded status slipped through.
    for (const expected of expectations.filter((row) => row.status !== SlotStatus.IN_PROGRESS)) {
      for (const slotId of expected.slotIds) {
        expect(enqueuedIds).not.toContain(slotId);
      }
    }
    expect(summary.enqueued).toBe(inProgress.length);
    expect(summary.suppressed).toBe(0);
  }, 60_000);

  it('treats the window boundary as ended: now-1ms and now are skipped, now+1ms is not', async () => {
    const ended = await openSlotFixture();
    const exactly = await openSlotFixture();
    const open = await openSlotFixture();

    await setWindow(ended.slotIds, windowIn(-1));
    await setWindow(exactly.slotIds, NOW);
    await setWindow(open.slotIds, windowIn(1));

    await expectSlotState([
      {
        role: 'slot whose window ended (now - 1ms)',
        slotIds: ended.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(-1),
      },
      {
        role: 'slot at the boundary (exactly now)',
        slotIds: exactly.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: NOW,
      },
      {
        role: 'slot whose window is open (now + 1ms)',
        slotIds: open.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(1),
      },
    ]);

    const { enqueue, sent } = recordingEnqueue();
    await sweepSettlements(context(enqueue).ctx);

    const enqueuedIds = sent.map((entry) => entry.data.slotId);

    expect(enqueuedIds).toEqual(open.slotIds);
    expect(enqueuedIds).not.toContain(ended.slotIds[0]);
    expect(enqueuedIds).not.toContain(exactly.slotIds[0]);
  });

  it('never enqueues a soft-deleted slot', async () => {
    const deleted = await openSlotFixture();
    const softDeletedAt = new Date(NOW.getTime() - 60 * SECOND);
    await setWindow(deleted.slotIds, windowIn(60 * SECOND), { deletedAt: softDeletedAt });

    await expectSlotState([
      {
        role: 'soft-deleted slot whose window is open',
        slotIds: deleted.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(60 * SECOND),
        deletedAt: softDeletedAt,
      },
    ]);

    const { enqueue, sent } = recordingEnqueue();
    await sweepSettlements(context(enqueue).ctx);

    expect(sent.map((entry) => entry.data.slotId)).not.toContain(deleted.slotIds[0]);
  });

  it('never enqueues a slot with no window', async () => {
    const noWindow = await openSlotFixture();
    await setWindow(noWindow.slotIds, null);

    await expectSlotState([
      {
        role: 'slot with no settlement window',
        slotIds: noWindow.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: null,
      },
    ]);

    const { enqueue, sent } = recordingEnqueue();
    await sweepSettlements(context(enqueue).ctx);

    expect(sent.map((entry) => entry.data.slotId)).not.toContain(noWindow.slotIds[0]);
  });

  it('sends each slot with its own singleton key and the 900 s bucket', async () => {
    const made = await openSlotFixture(2);
    await setWindow(made.slotIds, windowIn(60 * SECOND));

    await expectSlotState([
      {
        role: 'open slots',
        slotIds: made.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(60 * SECOND),
      },
    ]);

    const { enqueue, sent } = recordingEnqueue();
    await sweepSettlements(context(enqueue).ctx);

    const bySlot = new Map(sent.map((entry) => [entry.data.slotId, entry]));

    for (const slotId of made.slotIds) {
      const entry = bySlot.get(slotId);
      expect(entry).toBeDefined();
      expect(entry!.queue).toBe(SETTLE_SLOT_QUEUE);
      expect(entry!.options).toEqual({
        singletonKey: `settle:${slotId}`,
        singletonSeconds: 900,
      });
    }

    expect(SETTLE_SLOT_SINGLETON_SECONDS).toBe(900);
  });

  it('counts a suppressed send separately from an inserted one', async () => {
    const made = await openSlotFixture(2);
    await setWindow(made.slotIds, windowIn(60 * SECOND));

    await expectSlotState([
      {
        role: 'open slots, one of whose sends will be suppressed',
        slotIds: made.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(60 * SECOND),
      },
    ]);

    const suppressedSlotId = made.slotIds[0]!;
    const { enqueue } = recordingEnqueue((slotId) => (slotId === suppressedSlotId ? null : `job_${slotId}`));

    const summary = await sweepSettlements(context(enqueue).ctx);

    expect(summary).toEqual({ scanned: 2, enqueued: 1, suppressed: 1, truncated: false });
  });

  it('stops at its budget, reports truncation, and reaches the slots it cut off once they have been read', async () => {
    const made = await openSlotFixture(3);
    await setWindow(made.slotIds, windowIn(60 * SECOND));

    await expectSlotState([
      {
        role: 'open slots for the batch cap',
        slotIds: made.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(60 * SECOND),
      },
    ]);

    // Run 1: a budget of two, three never-read slots. The two it takes are the
    // first two in the order, and the third is left behind.
    const first = recordingEnqueue();
    const firstSummary = await sweepSettlements(context(first.enqueue).ctx, {
      batchSize: 2,
      maxBatches: 1,
    });

    // Whole-table counts: this test relies on the reset in beforeAll.
    expect(firstSummary).toEqual({ scanned: 2, enqueued: 2, suppressed: 0, truncated: true });

    const firstIds = first.sent.map((entry) => entry.data.slotId);
    expect(firstIds).toHaveLength(2);
    expect(new Set(firstIds).size).toBe(2);

    const cutOff = made.slotIds.filter((id) => !firstIds.includes(id));
    expect(cutOff, 'exactly one fixture slot must be left over').toHaveLength(1);

    // Exactly what settleSlot does when it reads a slot: ADVANCED and NO_CHANGE
    // both write lastViewCheckAt, and nothing else here changes.
    await prisma.campaignCreatorSlot.updateMany({
      where: { id: { in: firstIds } },
      data: { lastViewCheckAt: NOW },
    });

    const readRows = await prisma.campaignCreatorSlot.findMany({
      where: { id: { in: firstIds } },
      select: { id: true, lastViewCheckAt: true },
    });
    for (const row of readRows) {
      expect(row.lastViewCheckAt?.getTime(), `slot ${row.id} must look read`).toBe(NOW.getTime());
    }

    // Run 2: the two it read now sort behind the slot it never reached, so the
    // cut-off slot is served FIRST. The repeats hit the same 900-second bucket a
    // real pg-boss would apply, which is why re-enqueueing a read slot is a
    // suppressed send rather than a second settlement.
    const second = recordingEnqueue((slotId) =>
      firstIds.includes(slotId) ? null : `job_${slotId}`,
    );
    const secondSummary = await sweepSettlements(context(second.enqueue).ctx, {
      batchSize: 2,
      maxBatches: 2,
    });

    expect(second.sent[0]!.data.slotId).toBe(cutOff[0]);
    expect(secondSummary).toEqual({ scanned: 3, enqueued: 1, suppressed: 2, truncated: false });

    // Every fixture slot was handed off exactly once across the two runs.
    const inserted = second.sent
      .filter((entry) => !firstIds.includes(entry.data.slotId))
      .map((entry) => entry.data.slotId);
    expect(inserted).toEqual(cutOff);
    expect(new Set([...firstIds, ...inserted])).toEqual(new Set(made.slotIds));
    expect(new Set([...firstIds, ...inserted]).size).toBe(3);
  }, 60_000);

  it('serves a never-read slot before a read one, and the older read before the newer, ties by id', async () => {
    const neverRead = await openSlotFixture();
    const readOldest = await openSlotFixture();
    const readTie = await openSlotFixture();
    const readNewer = await openSlotFixture();

    const window = windowIn(60 * SECOND);
    const everySlot = [
      ...neverRead.slotIds,
      ...readOldest.slotIds,
      ...readTie.slotIds,
      ...readNewer.slotIds,
    ];
    await setWindow(everySlot, window);

    await expectSlotState([
      {
        role: 'never-read slot',
        slotIds: neverRead.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: window,
      },
      {
        role: 'oldest read slot',
        slotIds: readOldest.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: window,
      },
      {
        role: 'oldest read slot (tie)',
        slotIds: readTie.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: window,
      },
      {
        role: 'newer read slot',
        slotIds: readNewer.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: window,
      },
    ]);

    const older = new Date(NOW.getTime() - 120 * SECOND);
    const newer = new Date(NOW.getTime() - 60 * SECOND);
    await prisma.campaignCreatorSlot.updateMany({
      where: { id: { in: [...readOldest.slotIds, ...readTie.slotIds] } },
      data: { lastViewCheckAt: older },
    });
    await prisma.campaignCreatorSlot.updateMany({
      where: { id: { in: readNewer.slotIds } },
      data: { lastViewCheckAt: newer },
    });

    // The fixture self-check, extended to the column this test is about.
    const readBack = await prisma.campaignCreatorSlot.findMany({
      where: { id: { in: everySlot } },
      select: { id: true, lastViewCheckAt: true },
    });
    const lastReadAt = new Map(readBack.map((row) => [row.id, row.lastViewCheckAt?.getTime() ?? null]));
    expect(lastReadAt.get(neverRead.slotIds[0]!), 'never-read slot must have no read').toBeNull();
    expect(lastReadAt.get(readOldest.slotIds[0]!), 'oldest read slot').toBe(older.getTime());
    expect(lastReadAt.get(readTie.slotIds[0]!), 'oldest read slot (tie)').toBe(older.getTime());
    expect(lastReadAt.get(readNewer.slotIds[0]!), 'newer read slot').toBe(newer.getTime());

    const { enqueue, sent } = recordingEnqueue();
    const summary = await sweepSettlements(context(enqueue).ctx, { batchSize: 10, maxBatches: 1 });

    const order = sent.map((entry) => entry.data.slotId);

    expect(summary).toEqual({ scanned: 4, enqueued: 4, suppressed: 0, truncated: false });
    expect(new Set(order).size).toBe(4);

    // A NULL lastViewCheckAt sorts before any timestamp: unread work first.
    expect(order[0]).toBe(neverRead.slotIds[0]);

    // Then the two oldest reads, in the database's own id order. Reading the
    // expectation from Postgres keeps this assertion about the RULE (ties break
    // by id) rather than about a JavaScript string comparison.
    const tiedInIdOrder = (
      await prisma.campaignCreatorSlot.findMany({
        where: { id: { in: [...readOldest.slotIds, ...readTie.slotIds] } },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
    ).map((row) => row.id);
    expect(order.slice(1, 3)).toEqual(tiedInIdOrder);

    expect(order[3]).toBe(readNewer.slotIds[0]);
  }, 60_000);
});
