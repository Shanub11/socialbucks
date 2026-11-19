// apps/worker/src/jobs/settle-one.test.ts
//
// settleOne without a database and without the settlement engine: the slot is a
// value, `settleSlot` is a fake, and the logger records structure.
//
// Two properties are the reason this file exists:
//   1. every outcome is handled, so the switch cannot quietly drop a new one;
//   2. every thrown error is rethrown. The escrow invariant is a SettlementError
//      thrown from inside the settlement transaction, so "SettlementError means
//      the slot is gone" would be a lie, and the money failure would complete as
//      if it had been settled.

import type { PrismaClient } from '@repo/database';
import { SlotStatus } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';

import { MoneyError } from '@/lib/settlement/money';
import { SettlementError, type SettleOutcome } from '@/lib/settlement/settle-slot';

import { createRecordingLogger } from '../test-support/recording-logger';
import type { JobContext, JobDeps } from './context';
import { settleOne } from './settle-slot';

const NOW = new Date('2026-11-16T12:00:00.000Z');

interface SlotRow {
  status: SlotStatus;
  deletedAt: Date | null;
  disputedAt: Date | null;
  disputeResolvedAt: Date | null;
  settlementEndsAt: Date | null;
}

function openSlot(overrides: Partial<SlotRow> = {}): SlotRow {
  return {
    status: SlotStatus.IN_PROGRESS,
    deletedAt: null,
    disputedAt: null,
    disputeResolvedAt: null,
    settlementEndsAt: new Date(NOW.getTime() + 1_000),
    ...overrides,
  };
}

function context(row: SlotRow | null): {
  ctx: JobContext;
  recorder: ReturnType<typeof createRecordingLogger>;
} {
  const recorder = createRecordingLogger();
  const db = {
    campaignCreatorSlot: { findUnique: vi.fn(async () => row) },
  } as unknown as PrismaClient;

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

// ---------------------------------------------------------------------------
// The re-load decides everything it can
// ---------------------------------------------------------------------------

describe('settleOne pre-checks', () => {
  it('completes with a warn when the slot no longer exists, without calling settleSlot', async () => {
    const { ctx, recorder } = context(null);
    const { deps, settleSlot } = depsReturning({ status: 'HELD_NO_DATA', reason: 'no_analytics_data' });

    const summary = await settleOne(ctx, deps, 'slot_missing');

    expect(summary).toEqual({ outcome: 'not_found' });
    expect(settleSlot).not.toHaveBeenCalled();
    expect(recorder.at('warn')).toHaveLength(1);
    expect(recorder.at('warn')[0]!.fields).toEqual({ slotId: 'slot_missing' });
  });

  it.each([
    ['slot_not_in_progress', openSlot({ status: SlotStatus.DISPUTED })],
    ['slot_deleted', openSlot({ deletedAt: new Date(NOW.getTime() - 1_000) })],
  ])('skips with %s', async (reason, row) => {
    const { ctx, recorder } = context(row);
    const { deps, settleSlot } = depsReturning({ status: 'HELD_NO_DATA', reason: 'no_analytics_data' });

    const summary = await settleOne(ctx, deps, 'slot_1');

    expect(summary).toEqual({ outcome: 'skipped', reason });
    expect(settleSlot).not.toHaveBeenCalled();
    expect(recorder.at('info')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'SKIPPED_NOT_ELIGIBLE',
      reason,
    });
  });

  it('skips a DISPUTED slot by its status, without calling settleSlot', async () => {
    // A live dispute is the STATUS. The dispute record rides along, but it is
    // not what triggers the skip.
    const { ctx, recorder } = context(
      openSlot({
        status: SlotStatus.DISPUTED,
        disputedAt: new Date(NOW.getTime() - 1_000),
      }),
    );
    const { deps, settleSlot } = depsReturning({
      status: 'HELD_NO_DATA',
      reason: 'no_analytics_data',
    });

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'skipped',
      reason: 'slot_not_in_progress',
    });
    expect(settleSlot).not.toHaveBeenCalled();
    expect(recorder.at('info')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'SKIPPED_NOT_ELIGIBLE',
      reason: 'slot_not_in_progress',
    });
  });

  it('settles an IN_PROGRESS slot that a RESUME left with disputedAt and disputeResolvedAt set', async () => {
    // Regression: resolve-dispute.ts RESUME writes status IN_PROGRESS, the
    // extended window and disputeResolvedAt, and never clears disputedAt. A
    // disputedAt test would skip this slot forever, silently.
    const { ctx, recorder } = context(
      openSlot({
        disputedAt: new Date(NOW.getTime() - 60_000),
        disputeResolvedAt: new Date(NOW.getTime() - 30_000),
      }),
    );
    const { deps, settleSlot } = depsReturning({ status: 'NO_CHANGE', reason: 'no_new_tiers' });

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'no_change',
      reason: 'no_new_tiers',
    });
    expect(settleSlot).toHaveBeenCalledWith('slot_1', ctx.db);
    // The engine's answer is what is logged, so the read really happened.
    expect(recorder.at('info')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'NO_CHANGE',
      reason: 'no_new_tiers',
    });
  });

  it('settles an IN_PROGRESS slot with disputedAt set and no resolution', async () => {
    // The status is the source of truth: the DB trigger only allows DISPUTED out
    // of IN_PROGRESS and the CHECK requires a dispute record, so a live dispute
    // cannot exist without status DISPUTED. A leftover disputedAt on an
    // IN_PROGRESS slot is history, not a reason to skip.
    const { ctx } = context(openSlot({ disputedAt: new Date(NOW.getTime() - 60_000) }));
    const { deps, settleSlot } = depsReturning({ status: 'ADVANCED', newTiers: [], paidToDate: '0.00' } as unknown as SettleOutcome);

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'advanced' });
    expect(settleSlot).toHaveBeenCalledTimes(1);
  });

  it('treats a window ending exactly at now as ended', async () => {
    const { ctx } = context(openSlot({ settlementEndsAt: NOW }));
    const { deps, settleSlot } = depsReturning({ status: 'HELD_NO_DATA', reason: 'no_analytics_data' });

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'skipped',
      reason: 'window_ended',
    });
    expect(settleSlot).not.toHaveBeenCalled();
  });

  it('treats a null window as ended', async () => {
    const { ctx } = context(openSlot({ settlementEndsAt: null }));
    const { deps } = depsReturning({ status: 'HELD_NO_DATA', reason: 'no_analytics_data' });

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'skipped',
      reason: 'window_ended',
    });
  });

  it('calls settleSlot with the slot id and the context client', async () => {
    const { ctx } = context(openSlot());
    const { deps, settleSlot } = depsReturning({
      status: 'NO_CHANGE',
      reason: 'no_new_tiers',
    } as SettleOutcome);

    await settleOne(ctx, deps, 'slot_1');

    expect(settleSlot).toHaveBeenCalledTimes(1);
    expect(settleSlot).toHaveBeenCalledWith('slot_1', ctx.db);
  });
});

// ---------------------------------------------------------------------------
// Outcomes: exhaustive, logged by code
// ---------------------------------------------------------------------------

describe('settleOne outcomes', () => {
  it('logs ADVANCED by outcome code only', async () => {
    const { ctx, recorder } = context(openSlot());
    const { deps } = depsReturning({ status: 'ADVANCED', newTiers: [], paidToDate: '0.00' } as unknown as SettleOutcome);

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({ outcome: 'advanced' });

    const line = recorder.at('info')[0]!;
    expect(line.fields).toEqual({ slotId: 'slot_1', outcome: 'ADVANCED' });
    // No amount, no tier list: R6 allows counts and codes.
    expect(JSON.stringify(line.fields)).not.toContain('0.00');
  });

  it('logs NO_CHANGE with its reason', async () => {
    const { ctx, recorder } = context(openSlot());
    const { deps } = depsReturning({ status: 'NO_CHANGE', reason: 'no_new_tiers' });

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'no_change',
      reason: 'no_new_tiers',
    });
    expect(recorder.at('info')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'NO_CHANGE',
      reason: 'no_new_tiers',
    });
  });

  it('logs a skipped reason code from the engine unchanged', async () => {
    const { ctx, recorder } = context(openSlot());
    const { deps } = depsReturning({
      status: 'SKIPPED_NOT_ELIGIBLE',
      reason: 'platform_not_supported',
    });

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'skipped',
      reason: 'platform_not_supported',
    });
    expect(recorder.at('info')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'SKIPPED_NOT_ELIGIBLE',
      reason: 'platform_not_supported',
    });
  });

  it('logs HELD_NO_DATA by code', async () => {
    const { ctx, recorder } = context(openSlot());
    const { deps } = depsReturning({ status: 'HELD_NO_DATA', reason: 'no_analytics_data' });

    await expect(settleOne(ctx, deps, 'slot_1')).resolves.toEqual({
      outcome: 'held',
      reason: 'no_analytics_data',
    });
    expect(recorder.at('info')[0]!.fields).toEqual({
      slotId: 'slot_1',
      outcome: 'HELD_NO_DATA',
      reason: 'no_analytics_data',
    });
  });
});

// ---------------------------------------------------------------------------
// Errors: rethrown, never swallowed
// ---------------------------------------------------------------------------

describe('settleOne errors', () => {
  it('rethrows a SettlementError and never logs its message', async () => {
    const canary = 'CANARY_err_7c1';
    // The escrow invariant throws exactly this class from inside the settlement
    // transaction; it must reach pg-boss, not be treated as a missing slot.
    const failure = new SettlementError(
      `${canary}: paidToDate (600.00) exceeds escrowAmount (500.00) for slot slot_1. Rolling back.`,
    );

    const { ctx, recorder } = context(openSlot());
    const { deps } = depsReturning(failure);

    await expect(settleOne(ctx, deps, 'slot_1')).rejects.toThrow(SettlementError);

    expect(recorder.text()).not.toContain(canary);
    expect(recorder.text()).not.toContain('escrowAmount');
    // And nothing claimed the slot was settled.
    expect(recorder.at('info')).toHaveLength(0);
  });

  it('rethrows a MoneyError', async () => {
    const failure = new MoneyError('Currency "XYZ" is not in the supported 2-decimal allowlist.');

    const { ctx, recorder } = context(openSlot());
    const { deps } = depsReturning(failure);

    await expect(settleOne(ctx, deps, 'slot_1')).rejects.toThrow(MoneyError);
    expect(recorder.at('warn')).toHaveLength(0);
  });

  it('rethrows a provider error that is neither class', async () => {
    const failure = Object.assign(new Error('502 from the provider'), { status: 502 });

    const { ctx } = context(openSlot());
    const { deps } = depsReturning(failure);

    await expect(settleOne(ctx, deps, 'slot_1')).rejects.toThrow(failure);
  });

  it('fails loudly rather than completing when settleSlot is not bound', async () => {
    const { ctx } = context(openSlot());

    await expect(settleOne(ctx, {}, 'slot_1')).rejects.toThrow(/not bound/);
  });
});
