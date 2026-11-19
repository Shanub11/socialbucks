// apps/worker/src/jobs/close-sweep.test.ts
//
// Real database tests for the window-close sweep (ADR-0006 D10).
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the database is unreachable, the
// suite FAILS LOUDLY - it never silently skips.
//
// The sweep selects the whole table, so this file resets the slot tables once in
// beforeAll and asserts on its own fixture ids, except in the batch-cap test,
// which is about whole-table counts and relies on the reset.
//
// Two state builders are not what the sweep is about but what the sweep must
// exclude: DISPUTED and CLOSED cannot be inserted directly (CHECK constraints
// need the dispute record / closedAt, and the transition guard only allows them
// out of IN_PROGRESS), so they are built as transitions exactly as the app does.

import { prisma, SlotStatus } from '@repo/database';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createCampaignWithInvites,
  removeFixture,
  type CampaignFixture,
} from '../test-support/fixtures';
import { createRecordingLogger } from '../test-support/recording-logger';
import { resetSlotTables } from '../test-support/reset-test-db';
import { closeSweep } from './close-sweep';
import type { Enqueue, EnqueueContext } from './context';
import { CLOSE_SLOT_QUEUE, CLOSE_SLOT_SINGLETON_SECONDS } from './queues';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

if (!RUN_DB_TESTS) {
  console.warn(
    '[jobs/close-sweep.test] RUN_DB_TESTS != 1 - the window-close sweep tests are SKIPPED, not passing.',
  );
}

if (RUN_DB_TESTS && !process.env.TEST_DATABASE_URL) {
  throw new Error('[jobs/close-sweep.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.');
}

if (RUN_DB_TESTS && process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
  throw new Error(
    '[jobs/close-sweep.test] DATABASE_URL and TEST_DATABASE_URL must be the same database.',
  );
}

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

const NOW = new Date('2026-11-16T12:00:00.000Z');
const SECOND = 1_000;

/** A window that has already ended, which is what this sweep selects. */
function windowIn(ms: number): Date {
  return new Date(NOW.getTime() + ms);
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

function context(enqueue: Enqueue): {
  ctx: EnqueueContext;
  recorder: ReturnType<typeof createRecordingLogger>;
} {
  const recorder = createRecordingLogger();
  return { ctx: { db: prisma, logger: recorder.logger, now: () => NOW, enqueue }, recorder };
}

describeDb('closeSweep (real DB)', () => {
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

  /** An IN_PROGRESS slot: the only state this sweep will enqueue. */
  async function endedSlotFixture(count = 1): Promise<CampaignFixture> {
    return fixture({ count, status: SlotStatus.IN_PROGRESS });
  }

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

  async function makeDisputed(made: CampaignFixture, raisedByUserId: string): Promise<void> {
    await prisma.campaignCreatorSlot.update({
      where: { id: made.slotIds[0]! },
      data: {
        status: SlotStatus.DISPUTED,
        disputedAt: new Date(NOW.getTime() - 120 * SECOND),
        disputeReason: 'worker fixture dispute',
        disputeRaisedByUserId: raisedByUserId,
      },
    });
  }

  async function makeClosed(made: CampaignFixture): Promise<void> {
    await prisma.campaignCreatorSlot.update({
      where: { id: made.slotIds[0]! },
      data: {
        status: SlotStatus.CLOSED,
        closedAt: new Date(NOW.getTime() - 60 * SECOND),
      },
    });
  }

  /**
   * A slot that was disputed and then resumed by an operator: status
   * IN_PROGRESS, `disputedAt` still set (resolve-dispute.ts never clears it) and
   * `disputeResolvedAt` recording the resolution.
   */
  async function makeResumed(made: CampaignFixture, raisedByUserId: string): Promise<void> {
    await makeDisputed(made, raisedByUserId);
    await prisma.campaignCreatorSlot.update({
      where: { id: made.slotIds[0]! },
      data: {
        status: SlotStatus.IN_PROGRESS,
        disputeResolvedAt: new Date(NOW.getTime() - 60 * SECOND),
      },
    });
  }

  interface SlotExpectation {
    role: string;
    slotIds: string[];
    status: SlotStatus;
    settlementEndsAt: Date | null;
    deletedAt?: Date | null;
  }

  /** Reads the rows back and asserts the state the test intended to build. */
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

  it('enqueues only IN_PROGRESS, non-deleted slots whose window has ended', async () => {
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

    const disputed = await endedSlotFixture();
    await makeDisputed(disputed, disputed.userIds[0]!);
    const closed = await endedSlotFixture();
    await makeClosed(closed);

    const everySlot = [...byStatus.values(), disputed, closed].flatMap((made) => made.slotIds);
    const window = windowIn(-60 * SECOND);
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
    const summary = await closeSweep(context(enqueue).ctx);

    const enqueuedIds = sent
      .map((entry) => entry.data.slotId)
      .filter((id) => everySlot.includes(id));

    expect(new Set(enqueuedIds)).toEqual(new Set(inProgress));
    for (const expected of expectations.filter((row) => row.status !== SlotStatus.IN_PROGRESS)) {
      for (const slotId of expected.slotIds) {
        expect(enqueuedIds).not.toContain(slotId);
      }
    }
    expect(summary.enqueued).toBe(inProgress.length);

    // The send carries the close key, and only the close key.
    const one = sent.find((entry) => entry.data.slotId === inProgress[0])!;
    expect(one.queue).toBe(CLOSE_SLOT_QUEUE);
    expect(one.options).toEqual({
      singletonKey: `close:${inProgress[0]}`,
      singletonSeconds: CLOSE_SLOT_SINGLETON_SECONDS,
    });
  }, 60_000);

  it('selects a window ending at now, and not one ending 1ms later', async () => {
    const justEnded = await endedSlotFixture();
    const exactly = await endedSlotFixture();
    const stillOpen = await endedSlotFixture();

    await setWindow(justEnded.slotIds, windowIn(-1));
    await setWindow(exactly.slotIds, NOW);
    await setWindow(stillOpen.slotIds, windowIn(1));

    await expectSlotState([
      {
        role: 'slot whose window ended (now - 1ms)',
        slotIds: justEnded.slotIds,
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
        slotIds: stillOpen.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(1),
      },
    ]);

    const { enqueue, sent } = recordingEnqueue();
    await closeSweep(context(enqueue).ctx);

    const enqueuedIds = sent.map((entry) => entry.data.slotId);

    expect(enqueuedIds).toContain(justEnded.slotIds[0]);
    // The boundary belongs to this sweep, and to this sweep alone: the settle
    // sweep's `gt` never matches it.
    expect(enqueuedIds).toContain(exactly.slotIds[0]);
    expect(enqueuedIds).not.toContain(stillOpen.slotIds[0]);
  });

  it('never enqueues a soft-deleted slot whose window has ended', async () => {
    const deleted = await endedSlotFixture();
    const softDeletedAt = new Date(NOW.getTime() - 60 * SECOND);
    await setWindow(deleted.slotIds, windowIn(-60 * SECOND), { deletedAt: softDeletedAt });

    await expectSlotState([
      {
        role: 'soft-deleted slot with an ended window',
        slotIds: deleted.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(-60 * SECOND),
        deletedAt: softDeletedAt,
      },
    ]);

    const { enqueue, sent } = recordingEnqueue();
    await closeSweep(context(enqueue).ctx);

    expect(sent.map((entry) => entry.data.slotId)).not.toContain(deleted.slotIds[0]);
  });

  it('never enqueues a slot with no window: NULL is selected by neither sweep', async () => {
    const noWindow = await endedSlotFixture();
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
    await closeSweep(context(enqueue).ctx);

    expect(sent.map((entry) => entry.data.slotId)).not.toContain(noWindow.slotIds[0]);
  });

  it('enqueues a slot a RESUME left IN_PROGRESS with disputedAt and disputeResolvedAt set', async () => {
    // Regression for the removed `disputedAt` predicate: the status is the
    // source of truth, and a resumed slot is a live slot with an ended window.
    const resumed = await endedSlotFixture();
    await makeResumed(resumed, resumed.userIds[0]!);
    await setWindow(resumed.slotIds, windowIn(-60 * SECOND));

    const stored = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: resumed.slotIds[0]! },
      select: { status: true, disputedAt: true, disputeResolvedAt: true, settlementEndsAt: true },
    });
    expect(stored.status).toBe(SlotStatus.IN_PROGRESS);
    // Both dispute timestamps are still there - the fixture is the regression.
    expect(stored.disputedAt).not.toBeNull();
    expect(stored.disputeResolvedAt).not.toBeNull();
    expect(stored.settlementEndsAt?.getTime()).toBe(windowIn(-60 * SECOND).getTime());

    const { enqueue, sent } = recordingEnqueue();
    await closeSweep(context(enqueue).ctx);

    expect(sent.map((entry) => entry.data.slotId)).toContain(resumed.slotIds[0]);
  });

  it('serves the oldest ended window first', async () => {
    const oldest = await endedSlotFixture();
    const middle = await endedSlotFixture();
    const newest = await endedSlotFixture();

    const everySlot = [...oldest.slotIds, ...middle.slotIds, ...newest.slotIds];
    await setWindow(oldest.slotIds, windowIn(-180 * SECOND));
    await setWindow(middle.slotIds, windowIn(-120 * SECOND));
    await setWindow(newest.slotIds, windowIn(-60 * SECOND));

    await expectSlotState([
      {
        role: 'oldest ended window',
        slotIds: oldest.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(-180 * SECOND),
      },
      {
        role: 'middle ended window',
        slotIds: middle.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(-120 * SECOND),
      },
      {
        role: 'newest ended window',
        slotIds: newest.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(-60 * SECOND),
      },
    ]);

    const { enqueue, sent } = recordingEnqueue();
    await closeSweep(context(enqueue).ctx, { batchSize: 10, maxBatches: 1 });

    const order = sent
      .map((entry) => entry.data.slotId)
      .filter((id) => everySlot.includes(id));

    expect(order).toEqual([oldest.slotIds[0], middle.slotIds[0], newest.slotIds[0]]);
  });

  it('stops at its budget and reports truncation', async () => {
    const made = await endedSlotFixture(3);
    await setWindow(made.slotIds, windowIn(-60 * SECOND));

    await expectSlotState([
      {
        role: 'ended slots for the batch cap',
        slotIds: made.slotIds,
        status: SlotStatus.IN_PROGRESS,
        settlementEndsAt: windowIn(-60 * SECOND),
      },
    ]);

    const { enqueue, sent } = recordingEnqueue();
    const summary = await closeSweep(context(enqueue).ctx, { batchSize: 2, maxBatches: 1 });

    // Whole-table counts: this test relies on the reset in beforeAll.
    expect(summary).toEqual({ scanned: 2, enqueued: 2, suppressed: 0, truncated: true });
    expect(sent).toHaveLength(2);
  }, 60_000);
});
