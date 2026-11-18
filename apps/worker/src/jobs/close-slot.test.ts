// apps/worker/src/jobs/close-slot.test.ts
//
// Real database tests for the close job (ADR-0006 D10, ADR-0004 D2).
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. Unreachable means FAIL loudly, never skip.
//
// What is asserted here is money discipline, not plumbing:
//   - closing writes status and closedAt and nothing else: escrowAmount and
//     paidToDate are unchanged and NO PayoutEvent is written;
//   - a slot is closed only after a final read that succeeded;
//   - a row that changed under the job (dispute, resume, settle) is not closed.
//
// `settleSlot` is always a fake here. The point is what closeOne does around it,
// and a real read would need a provider.

import { MilestoneTier, prisma, Prisma, SlotStatus } from '@repo/database';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SettlementError, type SettleOutcome } from '@/lib/settlement/settle-slot';

import {
  createCampaignWithInvites,
  removeFixture,
  type CampaignFixture,
} from '../test-support/fixtures';
import { createRecordingLogger } from '../test-support/recording-logger';
import { resetSlotTables } from '../test-support/reset-test-db';
import type { JobContext, JobDeps } from './context';
import { closeOne } from './close-slot';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

if (!RUN_DB_TESTS) {
  console.warn(
    '[jobs/close-slot.test] RUN_DB_TESTS != 1 - the close-slot tests are SKIPPED, not passing.',
  );
}

if (RUN_DB_TESTS && !process.env.TEST_DATABASE_URL) {
  throw new Error('[jobs/close-slot.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.');
}

if (RUN_DB_TESTS && process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
  throw new Error(
    '[jobs/close-slot.test] DATABASE_URL and TEST_DATABASE_URL must be the same database.',
  );
}

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

const NOW = new Date('2026-11-16T12:00:00.000Z');
const SECOND = 1_000;

const NO_CHANGE: SettleOutcome = { status: 'NO_CHANGE', reason: 'no_new_tiers' };

function context(db = prisma): {
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

describeDb('closeOne (real DB)', () => {
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

  /** An IN_PROGRESS slot with 500.00 escrowed and nothing paid. */
  async function openSlotFixture(overrides: { escrowAmount?: string } = {}): Promise<CampaignFixture> {
    return fixture({
      status: SlotStatus.IN_PROGRESS,
      escrowAmount: overrides.escrowAmount ?? '500.00',
    });
  }

  async function setWindow(slotIds: string[], settlementEndsAt: Date | null): Promise<void> {
    await prisma.campaignCreatorSlot.updateMany({
      where: { id: { in: slotIds } },
      data: { settlementEndsAt },
    });
  }

  async function slotRow(slotId: string) {
    return prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: {
        status: true,
        closedAt: true,
        deletedAt: true,
        settlementEndsAt: true,
        disputedAt: true,
        disputeResolvedAt: true,
        escrowAmount: true,
        paidToDate: true,
      },
    });
  }

  /** Builds a DISPUTED slot the way the app does, from IN_PROGRESS. */
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

  /** The fixture self-check: the row must be what the case is about. */
  async function expectOpenWithEndedWindow(slotId: string): Promise<void> {
    const row = await slotRow(slotId);
    expect(row.status, `slot ${slotId} must be IN_PROGRESS`).toBe(SlotStatus.IN_PROGRESS);
    expect(row.deletedAt).toBeNull();
    expect(row.settlementEndsAt, `slot ${slotId} must have a window`).not.toBeNull();
    expect(row.settlementEndsAt!.getTime(), `slot ${slotId} window must have ended`).toBeLessThanOrEqual(
      NOW.getTime(),
    );
  }

  it('closes an ended slot with unreleased escrow without moving money', async () => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await setWindow(made.slotIds, new Date(NOW.getTime() - 60 * SECOND));
    await expectOpenWithEndedWindow(slotId);

    const eventsBefore = await prisma.payoutEvent.count({ where: { slotId } });
    expect(eventsBefore).toBe(0);

    const { ctx, recorder } = context();
    const { deps, settleSlot } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, slotId)).resolves.toEqual({ outcome: 'closed' });

    expect(settleSlot).toHaveBeenCalledWith(slotId, prisma);

    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.CLOSED);
    expect(after.closedAt?.getTime()).toBe(NOW.getTime());
    // Nothing about money moved.
    expect(after.escrowAmount.toFixed(2)).toBe('500.00');
    expect(after.paidToDate.toFixed(2)).toBe('0.00');
    expect(await prisma.payoutEvent.count({ where: { slotId } })).toBe(0);

    expect(recorder.at('info')[0]!.fields).toEqual({ slotId, outcome: 'CLOSED' });
    // No amount in any log argument.
    for (const amount of ['500.00', '0.00']) {
      expect(recorder.text()).not.toContain(amount);
    }
  });

  it('does nothing, and never reads the provider, while the window is open', async () => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await setWindow(made.slotIds, new Date(NOW.getTime() + 60 * SECOND));

    const { ctx } = context();
    const { deps, settleSlot } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, slotId)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'window_not_ended',
    });

    expect(settleSlot).not.toHaveBeenCalled();
    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.IN_PROGRESS);
    expect(after.closedAt).toBeNull();
  });

  it('does nothing on a DISPUTED slot', async () => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await makeDisputed(made, made.userIds[0]!);
    await setWindow(made.slotIds, new Date(NOW.getTime() - 60 * SECOND));

    const { ctx } = context();
    const { deps, settleSlot } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, slotId)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'slot_not_in_progress',
    });

    expect(settleSlot).not.toHaveBeenCalled();
    expect((await slotRow(slotId)).status).toBe(SlotStatus.DISPUTED);
  });

  it('closes a slot a RESUME left IN_PROGRESS with disputedAt still set', async () => {
    // Regression: the removed `disputedAt` predicate. A resumed slot is a live
    // slot; the dispute record stays on the row as history.
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await makeDisputed(made, made.userIds[0]!);
    await prisma.campaignCreatorSlot.update({
      where: { id: slotId },
      data: {
        status: SlotStatus.IN_PROGRESS,
        disputeResolvedAt: new Date(NOW.getTime() - 60 * SECOND),
      },
    });
    await setWindow(made.slotIds, new Date(NOW.getTime() - 30 * SECOND));

    await expectOpenWithEndedWindow(slotId);
    const before = await slotRow(slotId);
    expect(before.disputedAt).not.toBeNull();
    expect(before.disputeResolvedAt).not.toBeNull();

    const { ctx } = context();
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, slotId)).resolves.toEqual({ outcome: 'closed' });

    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.CLOSED);
    // The history is untouched by the close.
    expect(after.disputedAt?.getTime()).toBe(before.disputedAt?.getTime());
    expect(after.disputeResolvedAt?.getTime()).toBe(before.disputeResolvedAt?.getTime());
  });

  it('leaves the slot open and rethrows when the final read throws', async () => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await setWindow(made.slotIds, new Date(NOW.getTime() - 60 * SECOND));
    await expectOpenWithEndedWindow(slotId);

    const canary = 'CANARY_err_9d4';
    const failure = new SettlementError(`${canary}: paidToDate exceeds escrowAmount. Rolling back.`);

    const { ctx, recorder } = context();
    const { deps } = depsReturning(failure);

    await expect(closeOne(ctx, deps, slotId)).rejects.toThrow(SettlementError);

    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.IN_PROGRESS);
    expect(after.closedAt).toBeNull();
    expect(recorder.text()).not.toContain(canary);
  });

  it.each([
    ['SKIPPED_NOT_ELIGIBLE', { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'platform_null' } as SettleOutcome, 'read_skipped'],
    ['HELD_NO_DATA', { status: 'HELD_NO_DATA', reason: 'no_analytics_data' } as SettleOutcome, 'read_held'],
  ])('leaves the slot open after a %s read', async (_label, outcome, expected) => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await setWindow(made.slotIds, new Date(NOW.getTime() - 60 * SECOND));
    await expectOpenWithEndedWindow(slotId);

    const { ctx, recorder } = context();
    const { deps } = depsReturning(outcome);

    const summary = await closeOne(ctx, deps, slotId);
    expect(summary.outcome).toBe(expected);
    // It warns every sweep on purpose: that is how an operator finds the slot.
    expect(recorder.at('warn')).toHaveLength(1);

    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.IN_PROGRESS);
    expect(after.closedAt).toBeNull();
  });

  it('is a no-op when the final read completes the slot', async () => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await setWindow(made.slotIds, new Date(NOW.getTime() - 60 * SECOND));
    await expectOpenWithEndedWindow(slotId);

    // A fake that does what settleSlot does at TIER_100: write the ledger row
    // and complete the slot. The job must then not close it.
    //
    // Run in a transaction that is rolled back at the end: PayoutEvent is
    // append-only (no DELETE, and the slot FK is Restrict), so a committed ledger
    // row could never be cleaned up by a test. The rollback also proves the job
    // wrote nothing more than the fake did.
    const rollback = new Error('rollback');
    let observed: { status: SlotStatus; closedAt: Date | null } | undefined;

    await expect(
      prisma.$transaction(async (tx) => {
        const settleSlot = vi.fn(async () => {
          await tx.payoutEvent.create({
            data: {
              slotId,
              tier: MilestoneTier.TIER_100,
              amount: new Prisma.Decimal('500.00'),
              currency: 'USD',
              billableViews: 100_000,
              billableMetric: 'engagedViews',
              thresholdViews: 100_000,
              settlementJson: { kind: 'worker close-slot fixture' },
            },
          });
          await tx.campaignCreatorSlot.update({
            where: { id: slotId },
            data: { status: SlotStatus.COMPLETED, paidToDate: new Prisma.Decimal('500.00') },
          });
          return { status: 'ADVANCED', newTiers: [MilestoneTier.TIER_100], paidToDate: '500.00' } as unknown as SettleOutcome;
        });

        const recorder = createRecordingLogger();
        const ctx: JobContext = {
          db: tx as unknown as typeof prisma,
          logger: recorder.logger,
          now: () => NOW,
        };

        const summary = await closeOne(ctx, { settleSlot }, slotId);
        expect(summary).toEqual({ outcome: 'completed_by_read' });

        const row = await tx.campaignCreatorSlot.findUniqueOrThrow({
          where: { id: slotId },
          select: { status: true, closedAt: true },
        });
        observed = row;

        throw rollback;
      }),
    ).rejects.toThrow(rollback);

    // Inside the transaction the slot was COMPLETED; the close added nothing.
    expect(observed).toEqual({ status: SlotStatus.COMPLETED, closedAt: null });

    // And the rollback really rolled back: the fixture is untouched.
    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.IN_PROGRESS);
    expect(after.closedAt).toBeNull();
    expect(await prisma.payoutEvent.count({ where: { slotId } })).toBe(0);
  }, 60_000);

  it('errors on an open slot that is fully paid, and leaves it open', async () => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await prisma.campaignCreatorSlot.update({
      where: { id: slotId },
      data: { paidToDate: new Prisma.Decimal('500.00') },
    });
    await setWindow(made.slotIds, new Date(NOW.getTime() - 60 * SECOND));
    await expectOpenWithEndedWindow(slotId);

    const { ctx, recorder } = context();
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, slotId)).resolves.toEqual({
      outcome: 'in_progress_nothing_unreleased',
    });

    expect(recorder.at('error')[0]!.fields).toEqual({
      slotId,
      outcome: 'in_progress_nothing_unreleased',
    });
    expect(recorder.text()).not.toContain('500.00');

    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.IN_PROGRESS);
    expect(after.closedAt).toBeNull();
  });

  it('does not close when paidToDate changes between the second read and the CAS', async () => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await setWindow(made.slotIds, new Date(NOW.getTime() - 60 * SECOND));
    await expectOpenWithEndedWindow(slotId);

    // A settle job (or an operator) touching the row after the job's second read
    // and before its update. The CAS is pinned to the paidToDate it read, so the
    // update matches zero rows.
    let reads = 0;
    const racing = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== 'campaignCreatorSlot') {
          return Reflect.get(target, property, receiver);
        }
        const model = target.campaignCreatorSlot;
        return new Proxy(model, {
          get(modelTarget, modelProperty, modelReceiver) {
            if (modelProperty !== 'findUnique') {
              return Reflect.get(modelTarget, modelProperty, modelReceiver);
            }
            return async (args: Parameters<typeof modelTarget.findUnique>[0]) => {
              const row = await modelTarget.findUnique(args);
              reads += 1;
              if (reads === 2) {
                await prisma.campaignCreatorSlot.update({
                  where: { id: slotId },
                  data: { paidToDate: new Prisma.Decimal('1.00') },
                });
              }
              return row;
            };
          },
        });
      },
    }) as unknown as typeof prisma;

    const { ctx, recorder } = context(racing);
    const { deps } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, slotId)).resolves.toEqual({
      outcome: 'changed_concurrently',
    });

    const line = recorder.entries.find((entry) => entry.msg.includes('changed concurrently'));
    expect(line?.level).toBe('info');

    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.IN_PROGRESS);
    expect(after.closedAt).toBeNull();
    // The row is as the racing writer left it, not as the job planned.
    expect(after.paidToDate.toFixed(2)).toBe('1.00');
  });

  it('is a no-op on a slot that is already CLOSED', async () => {
    const made = await openSlotFixture();
    const slotId = made.slotIds[0]!;
    await setWindow(made.slotIds, new Date(NOW.getTime() - 60 * SECOND));
    await prisma.campaignCreatorSlot.update({
      where: { id: slotId },
      data: { status: SlotStatus.CLOSED, closedAt: new Date(NOW.getTime() - 30 * SECOND) },
    });

    const { ctx } = context();
    const { deps, settleSlot } = depsReturning(NO_CHANGE);

    await expect(closeOne(ctx, deps, slotId)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'slot_not_in_progress',
    });

    expect(settleSlot).not.toHaveBeenCalled();
    const after = await slotRow(slotId);
    expect(after.status).toBe(SlotStatus.CLOSED);
    // The original closure timestamp is not rewritten.
    expect(after.closedAt?.getTime()).toBe(new Date(NOW.getTime() - 30 * SECOND).getTime());
  });
});
