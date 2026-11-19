// apps/worker/src/jobs/settle-slot.ts
//
// One slot, one final read (ADR-0006 D3, D5).
//
// The job is a thin, suspicious wrapper around the web app's `settleSlot`:
//
//   - it re-loads the slot, so a slot that was disputed, deleted, cancelled or
//     whose window closed since the sweep enqueued it is skipped without
//     touching the provider (and without spending YouTube quota). "Disputed"
//     means STATUS `DISPUTED` and nothing else: `RESUME` puts a slot back to
//     IN_PROGRESS and deliberately leaves `disputedAt` set (it is the record of
//     the dispute, not its state), so `disputedAt` is never used as a predicate
//     here or anywhere else in the worker;
//   - a slot that no longer exists is a warn and a completed job - there is
//     nothing to retry, because the thing to retry on is gone;
//   - every outcome `settleSlot` returns is handled by an exhaustive switch, so
//     a new outcome in apps/web is a compile error here, not a silent one;
//   - every error it throws is rethrown. There is no `instanceof` branch: the
//     escrow invariant (paidToDate exceeds escrowAmount) is thrown as a
//     SettlementError from inside the settlement transaction, and swallowing
//     that as "the slot must be gone" would bury exactly the failure a human
//     must see. It retries per D4 and ends in the jobs.dead-letter log.
//
// R6: log lines carry the slot id, the outcome code and a reason code. Never a
// message, never a provider payload, never a token.

import { SlotStatus } from '@repo/database';

import type { SettleOutcome, SkippedReason } from '@/lib/settlement/settle-slot';

import type { JobContext, JobDeps } from './context';

/**
 * Reasons this job skips a slot before the settlement engine ever sees it.
 *
 * Kept separate from `SkippedReason` on purpose: these are the worker's own
 * re-check, and mixing them into the engine's union would blur which layer
 * decided the slot was not settleable.
 */
export type SettlePrecheckReason =
  | 'slot_not_in_progress'
  | 'slot_deleted'
  | 'window_ended';

export interface SettleOneSummary {
  outcome: 'not_found' | 'skipped' | 'advanced' | 'no_change' | 'held';
  reason?: SkippedReason | SettlePrecheckReason | 'no_analytics_data' | 'no_new_tiers';
}

/**
 * Settles one slot, or explains why it did not.
 *
 * @throws whatever `deps.settleSlot` throws - deliberately. pg-boss owns the
 *   retry (D4), and the dead-letter handler is what a human reads afterwards.
 */
export async function settleOne(
  ctx: JobContext,
  deps: JobDeps,
  slotId: string,
): Promise<SettleOneSummary> {
  const slot = await ctx.db.campaignCreatorSlot.findUnique({
    where: { id: slotId },
    select: {
      status: true,
      deletedAt: true,
      settlementEndsAt: true,
    },
  });

  // Gone between the sweep and this job: nothing to settle, nothing to retry.
  if (slot === null) {
    ctx.logger.warn('settlement.settle-slot: slot no longer exists', { slotId });
    return { outcome: 'not_found' };
  }

  if (slot.status !== SlotStatus.IN_PROGRESS) {
    return skipPrecheck(ctx, slotId, 'slot_not_in_progress');
  }
  if (slot.deletedAt !== null) {
    return skipPrecheck(ctx, slotId, 'slot_deleted');
  }
  // No `disputedAt` check: a slot that is currently disputed has status
  // DISPUTED and was skipped above. A resumed slot is IN_PROGRESS with
  // `disputedAt` still set (resolve-dispute.ts does not clear it), and testing
  // that column would skip it forever, silently.

  const now = ctx.now();
  if (slot.settlementEndsAt === null || slot.settlementEndsAt.getTime() <= now.getTime()) {
    // Exactly at the boundary counts as ended, the same rule the sweep uses.
    return skipPrecheck(ctx, slotId, 'window_ended');
  }

  const settleSlot = deps.settleSlot;
  if (settleSlot === undefined) {
    // A startup check in main.ts makes this unreachable in production; it stays
    // here so a missing binding can never look like a settled slot.
    throw new Error('settleSlot dependency is not bound');
  }

  const outcome = await settleSlot(slotId, ctx.db);

  return summarise(ctx, slotId, outcome);
}

/** Logs a pre-check skip and returns the summary. */
function skipPrecheck(
  ctx: JobContext,
  slotId: string,
  reason: SettlePrecheckReason,
): SettleOneSummary {
  ctx.logger.info('settlement.settle-slot: skipped', {
    slotId,
    outcome: 'SKIPPED_NOT_ELIGIBLE',
    reason,
  });
  return { outcome: 'skipped', reason };
}

/**
 * Turns a settlement outcome into a summary, exhaustively.
 *
 * The `never` assignment in the default branch is the point: adding an outcome to
 * `SettleOutcome` in apps/web stops this file compiling until it is handled.
 */
function summarise(ctx: JobContext, slotId: string, outcome: SettleOutcome): SettleOneSummary {
  switch (outcome.status) {
    case 'ADVANCED':
      ctx.logger.info('settlement.settle-slot: advanced', { slotId, outcome: 'ADVANCED' });
      return { outcome: 'advanced' };

    case 'NO_CHANGE':
      ctx.logger.info('settlement.settle-slot: no change', {
        slotId,
        outcome: 'NO_CHANGE',
        reason: outcome.reason,
      });
      return { outcome: 'no_change', reason: outcome.reason };

    case 'SKIPPED_NOT_ELIGIBLE':
      ctx.logger.info('settlement.settle-slot: skipped', {
        slotId,
        outcome: 'SKIPPED_NOT_ELIGIBLE',
        reason: outcome.reason,
      });
      return { outcome: 'skipped', reason: outcome.reason };

    case 'HELD_NO_DATA':
      ctx.logger.info('settlement.settle-slot: held', {
        slotId,
        outcome: 'HELD_NO_DATA',
        reason: outcome.reason,
      });
      return { outcome: 'held', reason: outcome.reason };

    default: {
      const unhandled: never = outcome;
      throw new Error(`settlement.settle-slot: unhandled outcome ${String(unhandled)}`);
    }
  }
}
