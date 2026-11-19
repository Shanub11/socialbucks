// apps/worker/src/jobs/close-slot.ts
//
// Close one slot whose settlement window has ended (ADR-0006 D10, ADR-0004 D2).
//
// CLOSED means: the window ended with unreleased escrow. Closing is a bookkeeping
// state change and NOT a payment: it writes `status = CLOSED` and `closedAt` and
// nothing else. `escrowAmount` and `paidToDate` are never touched, and no
// PayoutEvent is written. A CLOSED slot keeps counting its full escrow against
// the campaign's committed total until a return path exists.
//
// The order is the decision:
//
//   1. re-load and decide what can be decided without spending quota;
//   2. the FINAL READ - `deps.settleSlot`, the same read the settle job makes.
//      A slot is only closed after that read actually succeeded (ADVANCED or
//      NO_CHANGE). SKIPPED_NOT_ELIGIBLE and HELD_NO_DATA are answers, not reads:
//      the slot stays IN_PROGRESS and the job warns. That warning repeats on
//      every close sweep for a permanently unreadable slot, by design - it is
//      how an operator finds it (OQ-10);
//   3. re-load again and only then decide to close, on the values just read;
//   4. a CAS pinned to status, deletedAt, settlementEndsAt and paidToDate. A
//      dispute raised mid-job (status DISPUTED), a resume that moved the window,
//      or a settle that changed paidToDate all make it match zero rows: the slot
//      stays as it is and the next sweep re-evaluates.
//
// Every error from `settleSlot` is rethrown, with no `instanceof` branch: the
// escrow invariant is a SettlementError thrown inside the settlement
// transaction, and swallowing it would close a slot whose ledger is broken. It
// retries per D4 and ends in the dead-letter log.
//
// R6: the only things logged are the slot id, an outcome code and a reason code.
// Never an amount - the unreleased figures are decimal money and are the one
// thing this job can see that must not reach a log line.

import { SlotStatus } from '@repo/database';

import type { SkippedReason, SettleOutcome } from '@/lib/settlement/settle-slot';

import type { JobContext, JobDeps } from './context';

/**
 * Reasons this job skips a slot before the final read.
 *
 * `window_not_ended` covers a NULL window too: a slot with no window has no
 * ended window to close, and there is no separate code for "no window" because
 * the action is the same - leave it alone.
 */
export type ClosePrecheckReason = 'slot_not_in_progress' | 'slot_deleted' | 'window_not_ended';

/** What closing one slot did, as a code. */
export type CloseOneOutcome =
  | 'not_found'
  | 'skipped'
  | 'read_skipped'
  | 'read_held'
  | 'completed_by_read'
  | 'status_changed'
  | 'window_changed'
  | 'closed'
  | 'changed_concurrently'
  | 'negative_unreleased'
  | 'in_progress_nothing_unreleased';

export interface CloseOneSummary {
  outcome: CloseOneOutcome;
  reason?: ClosePrecheckReason | SkippedReason | 'no_analytics_data';
}

/** What the pre-check needs to see. */
const PRECHECK_FIELDS = {
  status: true,
  deletedAt: true,
  settlementEndsAt: true,
} as const;

/** What the close decision needs: the same fields plus the two money columns. */
const DECISION_FIELDS = {
  status: true,
  deletedAt: true,
  settlementEndsAt: true,
  escrowAmount: true,
  paidToDate: true,
} as const;

/**
 * Closes one slot whose window ended with unreleased escrow, or explains why it
 * did not.
 *
 * @throws whatever `deps.settleSlot` throws - deliberately. pg-boss owns the
 *   retry (D4) and the dead-letter handler is what a human reads afterwards.
 */
export async function closeOne(
  ctx: JobContext,
  deps: JobDeps,
  slotId: string,
): Promise<CloseOneSummary> {
  // One instant for the whole job: the window decision, the CAS' `closedAt` and
  // the re-check after the final read all use it.
  const now = ctx.now();

  const slot = await ctx.db.campaignCreatorSlot.findUnique({
    where: { id: slotId },
    select: PRECHECK_FIELDS,
  });

  // Gone between the sweep and this job: nothing to close, nothing to retry.
  if (slot === null) {
    ctx.logger.warn('settlement.close-slot: slot no longer exists', { slotId });
    return { outcome: 'not_found' };
  }

  if (slot.status !== SlotStatus.IN_PROGRESS) {
    return skipPrecheck(ctx, slotId, 'slot_not_in_progress');
  }
  if (slot.deletedAt !== null) {
    return skipPrecheck(ctx, slotId, 'slot_deleted');
  }
  // A NULL window is not an ended window. `<=` is the same boundary the sweep
  // uses, so a slot whose window ends exactly at this instant is closeable.
  if (slot.settlementEndsAt === null || slot.settlementEndsAt.getTime() > now.getTime()) {
    return skipPrecheck(ctx, slotId, 'window_not_ended');
  }

  const settleSlot = deps.settleSlot;
  if (settleSlot === undefined) {
    // A startup check in main.ts makes this unreachable in production; it stays
    // here so a missing binding can never look like a closed slot.
    throw new Error('settleSlot dependency is not bound');
  }

  // The final read. Every error propagates untouched (see the header).
  const outcome = await settleSlot(slotId, ctx.db);

  switch (outcome.status) {
    case 'ADVANCED':
    case 'NO_CHANGE':
      // The read succeeded; the slot may now be COMPLETED (TIER_100) or still
      // IN_PROGRESS. Step 3 decides from the stored row, not from this outcome.
      break;

    case 'SKIPPED_NOT_ELIGIBLE':
      // The read did not happen. The slot is NOT closed and stays IN_PROGRESS.
      ctx.logger.warn('settlement.close-slot: the final read did not succeed', {
        slotId,
        outcome: 'SKIPPED_NOT_ELIGIBLE',
        reason: outcome.reason,
      });
      return { outcome: 'read_skipped', reason: outcome.reason };

    case 'HELD_NO_DATA':
      ctx.logger.warn('settlement.close-slot: the final read did not succeed', {
        slotId,
        outcome: 'HELD_NO_DATA',
        reason: outcome.reason,
      });
      return { outcome: 'read_held', reason: outcome.reason };

    default: {
      const unhandled: never = outcome;
      throw new Error(`settlement.close-slot: unhandled outcome ${String(unhandled)}`);
    }
  }

  // What is actually stored now. The close is decided here, on this read.
  const stored = await ctx.db.campaignCreatorSlot.findUnique({
    where: { id: slotId },
    select: DECISION_FIELDS,
  });

  if (stored === null) {
    ctx.logger.warn('settlement.close-slot: slot no longer exists', { slotId });
    return { outcome: 'not_found' };
  }

  if (stored.status === SlotStatus.COMPLETED) {
    // The final read paid the last tier, which ends the slot. Nothing to close.
    ctx.logger.info('settlement.close-slot: completed by the final read', {
      slotId,
      outcome: 'COMPLETED',
    });
    return { outcome: 'completed_by_read' };
  }

  if (stored.status !== SlotStatus.IN_PROGRESS || stored.deletedAt !== null) {
    // Disputed, cancelled, expired or soft-deleted while the read ran. A dispute
    // in particular must never be closed over.
    ctx.logger.info('settlement.close-slot: changed after the final read', {
      slotId,
      outcome: 'status_changed',
    });
    return { outcome: 'status_changed' };
  }

  if (stored.settlementEndsAt === null || stored.settlementEndsAt.getTime() > now.getTime()) {
    // A resume extended the window (or something cleared it). The slot is open
    // again; the close sweep will find it when the new window ends.
    ctx.logger.info('settlement.close-slot: the window changed after the final read', {
      slotId,
      outcome: 'window_changed',
    });
    return { outcome: 'window_changed' };
  }

  // Decimal arithmetic, never floats. unreleased = escrowAmount - paidToDate.
  const unreleased = stored.escrowAmount.minus(stored.paidToDate);

  if (unreleased.lessThan(0)) {
    // Impossible while `slot_paid_within_escrow` holds; a broken invariant means
    // a human must look, so this is an error and never a close. No amounts: R6.
    ctx.logger.error('settlement.close-slot: negative unreleased escrow', {
      slotId,
      outcome: 'negative_unreleased',
    });
    return { outcome: 'negative_unreleased' };
  }

  if (unreleased.isZero()) {
    // A fully paid slot in IN_PROGRESS should have been COMPLETED by the final
    // read. Closing it would be right in money terms but would hide the bug.
    ctx.logger.error('settlement.close-slot: nothing unreleased on an open slot', {
      slotId,
      outcome: 'in_progress_nothing_unreleased',
    });
    return { outcome: 'in_progress_nothing_unreleased' };
  }

  const result = await ctx.db.campaignCreatorSlot.updateMany({
    // The CAS: the read's condition plus the exact values read. Any of them
    // moving between the read and this statement makes the row not match.
    where: {
      id: slotId,
      status: SlotStatus.IN_PROGRESS,
      deletedAt: null,
      settlementEndsAt: stored.settlementEndsAt,
      paidToDate: stored.paidToDate,
    },
    // Status and the closure timestamp. Nothing about money.
    data: { status: SlotStatus.CLOSED, closedAt: now },
  });

  if (result.count === 1) {
    ctx.logger.info('settlement.close-slot: closed', { slotId, outcome: 'CLOSED' });
    return { outcome: 'closed' };
  }

  // Losing the race is normal: a dispute, a resume or a settle won. The next
  // sweep re-evaluates the slot from scratch.
  ctx.logger.info('settlement.close-slot: changed concurrently', {
    slotId,
    outcome: 'changed_concurrently',
  });
  return { outcome: 'changed_concurrently' };
}

/** Logs a pre-check skip and returns the summary. */
function skipPrecheck(
  ctx: JobContext,
  slotId: string,
  reason: ClosePrecheckReason,
): CloseOneSummary {
  ctx.logger.info('settlement.close-slot: skipped', {
    slotId,
    outcome: 'SKIPPED_NOT_ELIGIBLE',
    reason,
  });
  return { outcome: 'skipped', reason };
}
