// apps/worker/src/jobs/close-slot.pure.test.ts
//
// closeOne without a database: the slot rows are values, `settleSlot` is a fake,
// and the logger records structure.
//
// Three properties are why this file exists:
//   1. a slot is closed ONLY after the final read succeeded. A skipped or held
//      read leaves it IN_PROGRESS and warns - closing on a read that never
//      happened would close a slot on a network error;
//   2. the close is a CAS pinned to the values that were read, so a dispute, a
//      resume or a settle that lands mid-job makes it a no-op;
//   3. no amount ever reaches a log argument (R6). The unreleased figure is
//      money, and it is the one thing this job can see that must stay out of the
//      log line.

import type { PrismaClient } from '@repo/database';
import { Prisma, SlotStatus } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';

import { MoneyError } from '@/lib/settlement/money';
import { SettlementError, type SettleOutcome } from '@/lib/settlement/settle-slot';

import { createRecordingLogger } from '../test-support/recording-logger';
import { closeOne } from './close-slot';
import type { JobContext, JobDeps } from './context';

const NOW = new Date('2026-11-16T12:00:00.000Z');

const money = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

interface SlotRow {
  status: SlotStatus;
  deletedAt: Date | null;
  settlementEndsAt: Date | null;
  escrowAmount: Prisma.Decimal;
  paidToDate: Prisma.Decimal;
}

/** An ended, live, IN_PROGRESS slot with unreleased escrow: the close case. */
function endedSlot(overrides: Partial<SlotRow> = {}): SlotRow {
  return {
    status: SlotStatus.IN_PROGRESS,
    deletedAt: null,
    settlementEndsAt: new Date(NOW.getTime() - 1_000),
    escrowAmount: money('500.00'),
    paidToDate: money('100.00'),
    ...overrides,
  };
}

interface UpdateManyArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface StubDb {
  db: PrismaClient;
  reads: unknown[];
  writes: UpdateManyArgs[];
  otherWrites: string[];
}

/**
 * A slot table that answers `findUnique` with `rows` in call order and records
 * `updateMany`. A call past the last row answers null, which is what a real
 * query does when the row is gone.
 */
function stubDb(rows: Array<SlotRow | null>, updateCount = 1): StubDb {
  const reads: unknown[] = [];
  const writes: UpdateManyArgs[] = [];
  const otherWrites: string[] = [];
  let index = 0;

  const write =
    (name: string) =>
    async (): Promise<unknown> => {
      otherWrites.push(name);
      return { count: 0 };
    };

  const db = {
    campaignCreatorSlot: {
      findUnique: async (args: unknown) => {
        reads.push(args);
        const row = rows[index] ?? null;
        index += 1;
        return row;
      },
      updateMany: async (args: UpdateManyArgs) => {
        writes.push(args);
        return { count: updateCount };
      },
      count: write('count'),
      create: write('create'),
      createMany: write('createMany'),
      update: write('update'),
      delete: write('delete'),
      deleteMany: write('deleteMany'),
      upsert: write('upsert'),
    },
  } as unknown as PrismaClient;

  return { db, reads, writes, otherWrites };
}

function context(db: PrismaClient): {
  ctx: JobContext;
  recorder: ReturnType<typeof createRecordingLogger>;
} {
  const recorder = createRecordingLogger();
  return { ctx: { db, logger: recorder.logger, now: () => NOW }, recorder };
}

function depsReturning(outcome: SettleOutcome | Error): {
  deps: JobDeps;
  settleSlot: ReturnType<typeof vi.fn>;
} {
  const settleSlot = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });

  return { deps: { settleSlot }, settleSlot };
}

const NO_CHANGE: SettleOutcome = { status: 'NO_CHANGE', reason: 'no_new_tiers' };
const ADVANCED = {
  status: 'ADVANCED',
  newTiers: [],
  paidToDate: '0.00',
} as unknown as SettleOutcome;

// ---------------------------------------------------------------------------
// Pre-checks: nothing is read from the provider before these pass
// ---------------------------------------------------------------------------

describe('closeOne pre-checks', () => {
  it('warns and completes when the slot no longer exists', async () => {
    const stub = stubDb([null]);
    const { ctx, recorder } = context(stub.db);
    const { deps, settleSlot } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_missing')).resolves.toEqual({ outcome: 'not_found' });

    expect(settleSlot).not.toHaveBeenCalled();
    expect(recorder.at('warn')[0]!.fields).toEqual({ slotId: 'slot_missing' });
    expect(stub.writes).toEqual([]);
  });

  it.each([
    [
      'slot_not_in_progress',
      endedSlot({ status: SlotStatus.DISPUTED }),
    ],
    [
      'slot_deleted',
      endedSlot({ deletedAt: new Date(NOW.getTime() - 60_000) }),
    ],
    [
      'window_not_ended',
      endedSlot({ settlementEndsAt: new Date(NOW.getTime() + 1_000) }),
    ],
  ])('skips with %s and never calls settleSlot', async (reason, row) => {
    const stub = stubDb([row]);
    const { ctx, recorder } = context(stub.db);
    const { deps, settleSlot } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'skipped', reason });

    expect(settleSlot).not.toHaveBeenCalled();
    expect(recorder.at('info')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'SKIPPED_NOT_ELIGIBLE',
      reason,
    });
    expect(stub.writes).toEqual([]);
  });

  it('treats a NULL window as not ended, under the window_not_ended code', async () => {
    const stub = stubDb([endedSlot({ settlementEndsAt: null })]);
    const { ctx } = context(stub.db);
    const { deps, settleSlot } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'skipped',
      reason: 'window_not_ended',
    });
    expect(settleSlot).not.toHaveBeenCalled();
  });

  it('treats a window ending exactly at now as ended', async () => {
    const stub = stubDb([endedSlot({ settlementEndsAt: NOW }), endedSlot()]);
    const { ctx } = context(stub.db);
    const { deps, settleSlot } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'closed' });
    expect(settleSlot).toHaveBeenCalledTimes(1);
  });

  it('fails loudly rather than completing when settleSlot is not bound', async () => {
    const stub = stubDb([endedSlot()]);
    const { ctx } = context(stub.db);

    await expect(closeOne(ctx, {}, 'slot_1')).rejects.toThrow(/not bound/);
    expect(stub.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The final read decides whether a close may happen at all
// ---------------------------------------------------------------------------

describe('closeOne final read', () => {
  it.each([
    ['ADVANCED', ADVANCED],
    ['NO_CHANGE', NO_CHANGE],
  ])('closes after a successful %s read', async (_label, outcome) => {
    const stub = stubDb([endedSlot(), endedSlot()]);
    const { ctx } = context(stub.db);
    const { deps, settleSlot } = depsReturning(outcome);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'closed' });

    expect(settleSlot).toHaveBeenCalledWith('slot_1', stub.db);
    expect(stub.writes).toHaveLength(1);
    expect(stub.writes[0]!.data).toEqual({ status: SlotStatus.CLOSED, closedAt: NOW });
  });

  it('does not close after a skipped read, and warns with the reason', async () => {
    const stub = stubDb([endedSlot()]);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning({
      status: 'SKIPPED_NOT_ELIGIBLE',
      reason: 'social_account_revoked',
    });

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'read_skipped',
      reason: 'social_account_revoked',
    });

    const warning = recorder.at('warn')[0]!;
    expect(warning.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'SKIPPED_NOT_ELIGIBLE',
      reason: 'social_account_revoked',
    });
    expect(stub.writes).toEqual([]);
  });

  it('does not close after a held read, and warns with the reason', async () => {
    const stub = stubDb([endedSlot()]);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning({ status: 'HELD_NO_DATA', reason: 'no_analytics_data' });

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'read_held',
      reason: 'no_analytics_data',
    });

    expect(recorder.at('warn')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'HELD_NO_DATA',
      reason: 'no_analytics_data',
    });
    expect(stub.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Errors: rethrown, never treated as an outcome
// ---------------------------------------------------------------------------

describe('closeOne errors', () => {
  it('rethrows a SettlementError and never logs its message', async () => {
    const canary = 'CANARY_err_9d4';
    const failure = new SettlementError(
      `${canary}: paidToDate (600.00) exceeds escrowAmount (500.00) for slot slot_1. Rolling back.`,
    );

    const stub = stubDb([endedSlot()]);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning(failure);

    await expect(closeOne(ctx, deps, 'slot_1')).rejects.toThrow(SettlementError);

    expect(recorder.text()).not.toContain(canary);
    expect(recorder.text()).not.toContain('600.00');
    expect(stub.writes).toEqual([]);
  });

  it('rethrows a MoneyError', async () => {
    const failure = new MoneyError('Currency "XYZ" is not in the supported 2-decimal allowlist.');

    const stub = stubDb([endedSlot()]);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning(failure);

    await expect(closeOne(ctx, deps, 'slot_1')).rejects.toThrow(MoneyError);
    expect(recorder.at('warn')).toHaveLength(0);
    expect(stub.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Money: 0 or negative unreleased never closes and never logs an amount
// ---------------------------------------------------------------------------

describe('closeOne unreleased escrow', () => {
  it('errors on negative unreleased without closing or logging an amount', async () => {
    // The real table forbids this (`slot_paid_within_escrow`); the stub can build
    // it, and the job must treat a broken invariant as a human problem.
    const stub = stubDb([
      endedSlot(),
      endedSlot({ escrowAmount: money('500.00'), paidToDate: money('600.00') }),
    ]);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'negative_unreleased',
    });

    const error = recorder.at('error')[0]!;
    expect(error.fields).toEqual({ slotId: 'slot_1', outcome: 'negative_unreleased' });
    expect(stub.writes).toEqual([]);
    expect(recorder.text()).not.toContain('600.00');
    expect(recorder.text()).not.toContain('-100.00');
  });

  it('errors on nothing unreleased without closing', async () => {
    const stub = stubDb([
      endedSlot(),
      endedSlot({ escrowAmount: money('500.00'), paidToDate: money('500.00') }),
    ]);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'in_progress_nothing_unreleased',
    });

    expect(recorder.at('error')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'in_progress_nothing_unreleased',
    });
    expect(stub.writes).toEqual([]);
  });

  it('never puts an amount in any log argument on the closing path', async () => {
    const stub = stubDb([endedSlot(), endedSlot()]);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning(NO_CHANGE);

    await closeOne(ctx, deps, 'slot_1');

    // escrowAmount 500.00, paidToDate 100.00, unreleased 400.00: none of them.
    for (const amount of ['500.00', '100.00', '400.00']) {
      expect(recorder.text()).not.toContain(amount);
    }
  });
});

// ---------------------------------------------------------------------------
// The CAS
// ---------------------------------------------------------------------------

describe('closeOne CAS', () => {
  it('pins status, deletedAt, settlementEndsAt and paidToDate to the values read', async () => {
    const readAt = new Date(NOW.getTime() - 5_000);
    const row = endedSlot({ settlementEndsAt: readAt });
    const stub = stubDb([row, row]);
    const { ctx } = context(stub.db);
    const { deps } = depsReturning(NO_CHANGE);

    await closeOne(ctx, deps, 'slot_1');

    const where = stub.writes[0]!.where;
    expect(where).toMatchObject({
      id: 'slot_1',
      status: SlotStatus.IN_PROGRESS,
      deletedAt: null,
      settlementEndsAt: readAt,
    });
    // Decimal identity matters for the CAS: format it rather than trust toEqual.
    expect((where.paidToDate as Prisma.Decimal).toFixed(2)).toBe('100.00');
    expect(where.settlementEndsAt).toBe(readAt);
  });

  it('logs a lost race and completes when the CAS matches no row', async () => {
    // A dispute, a resume or a settle changed the row after the read.
    const stub = stubDb([endedSlot(), endedSlot()], 0);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'changed_concurrently',
    });

    const line = recorder.entries.find((entry) => entry.msg.includes('changed concurrently'));
    expect(line?.level).toBe('info');
    expect(line?.fields).toEqual({ slotId: 'slot_1', outcome: 'changed_concurrently' });
    expect(recorder.at('error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// What the second re-load can say
// ---------------------------------------------------------------------------

describe('closeOne after the final read', () => {
  it('is a no-op when the read completed the slot', async () => {
    const stub = stubDb([endedSlot(), endedSlot({ status: SlotStatus.COMPLETED })]);
    const { ctx, recorder } = context(stub.db);
    const { deps } = depsReturning(ADVANCED);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'completed_by_read' });

    expect(stub.writes).toEqual([]);
    expect(recorder.at('info')[0]!.fields).toEqual({ slotId: 'slot_1', outcome: 'COMPLETED' });
  });

  it('is a no-op when the slot was disputed during the read', async () => {
    const stub = stubDb([endedSlot(), endedSlot({ status: SlotStatus.DISPUTED })]);
    const { ctx } = context(stub.db);
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'status_changed' });
    expect(stub.writes).toEqual([]);
  });

  it('is a no-op when a resume moved the window into the future', async () => {
    const stub = stubDb([
      endedSlot(),
      endedSlot({ settlementEndsAt: new Date(NOW.getTime() + 60_000) }),
    ]);
    const { ctx } = context(stub.db);
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'window_changed' });
    expect(stub.writes).toEqual([]);
  });

  it('is a no-op when the slot was soft-deleted during the read', async () => {
    const stub = stubDb([endedSlot(), endedSlot({ deletedAt: new Date(NOW.getTime() - 1_000) })]);
    const { ctx } = context(stub.db);
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'status_changed' });
    expect(stub.writes).toEqual([]);
  });
});
