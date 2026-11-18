// apps/worker/src/jobs/sweep-settlements.ts
//
// The settlement sweep: find the slots whose settlement window is open and hand
// each one to a settle job (ADR-0006 D3, D5).
//
// The predicate is deliberately narrow, and each clause is load-bearing:
//
//   status: IN_PROGRESS          - the only state settleSlot will read (D5). A
//                                  DISPUTED, CLOSED, CANCELLED, COMPLETED or
//                                  pre-acceptance slot is never enqueued.
//   deletedAt: null              - a soft-deleted slot is not billed. This is
//                                  the opposite of the invite sweeper, which
//                                  deliberately includes them because their
//                                  escrow still counts; settlement is the other
//                                  side of that decision.
//   settlementEndsAt > now       - the window is still open. A NULL window never
//                                  matches (the comparison excludes NULL), and a
//                                  window ending exactly at `now` counts as
//                                  ended: the close sweep owns it, not this one.
//
// Nothing carries progress between runs: no cursor is stored, and enqueueing
// changes no row. What makes a second run different is the ORDER, which puts the
// slots this run could not reach at the front:
//
//   lastViewCheckAt ASC NULLS FIRST, then id ASC
//
// `settleSlot` writes `lastViewCheckAt` when it actually reads a slot (ADVANCED
// and NO_CHANGE both do), so a slot that has been read sorts behind every slot
// that has not been read since - including every slot that was never read at all.
// Ties break by id, which makes the order total and the paging stable.
//
// The limitation, stated in ADR-0006 D3b and tracked as OQ-9: SKIPPED_NOT_ELIGIBLE
// and HELD_NO_DATA write nothing, so such a slot keeps its NULL `lastViewCheckAt`
// and holds its place at the front. More than one run's budget of them, and the
// slots behind them are never reached.
//
// Bounded like every other job (R3): 100 ids per statement, 20 statements per run,
// 2,000 slots. Paging uses skip/take over that total order rather than a keyset:
// the order starts with a nullable column, and a keyset over
// (lastViewCheckAt, id) would need raw SQL to express NULLS FIRST (R5). A settle
// job that commits mid-run moves its slot behind the window, which can make the
// run skip one row; that row is never read by anyone else, so the next run starts
// at the front and reaches it.

import { SlotStatus } from '@repo/database';

import type { EnqueueContext } from './context';
import { SETTLE_SLOT_QUEUE, SETTLE_SLOT_SINGLETON_SECONDS } from './queues';

/** Rows per page. Small enough that one page is a short index scan. */
export const SETTLEMENT_SWEEP_BATCH_SIZE = 100;

/** Pages per run: 20 x 100 = 2,000 slots considered per sweep at most. */
export const SETTLEMENT_SWEEP_MAX_BATCHES = 20;

/**
 * The sweep's total order, in one place so the page and the truncation probe
 * cannot drift apart.
 *
 * `nulls: 'first'` is the load-bearing part: a never-read slot has no timestamp,
 * and it must sort before any slot that has one.
 */
export type SettlementSweepOrderBy = Array<
  | { lastViewCheckAt: { sort: 'asc'; nulls: 'first' } }
  | { id: 'asc' }
>;

export function settlementSweepOrderBy(): SettlementSweepOrderBy {
  return [{ lastViewCheckAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }];
}

export interface SettlementSweepSummary {
  /** Slots the sweep considered, before any dedupe by pg-boss. */
  scanned: number;
  /** Slots a job was actually inserted for (the send returned an id). */
  enqueued: number;
  /**
   * Slots whose send pg-boss suppressed because the slot already had a job in
   * this bucket, or already had one queued. Not an error, and not work handed
   * off - it is the throttle doing its job.
   */
  suppressed: number;
  /** True when the run stopped at its budget instead of running out of work. */
  truncated: boolean;
}

/** Injectable bounds; the tests narrow them so the cap is provable. */
export interface SettlementSweepLimits {
  batchSize?: number;
  maxBatches?: number;
}

/** The singleton key for one slot: one key per slot, per queue. */
export function settleSingletonKey(slotId: string): string {
  return `settle:${slotId}`;
}

/**
 * Enqueues one settle job per open slot, at most once per slot per bucket.
 *
 * Idempotent (R4): running it twice in the same bucket enqueues nothing the
 * second time (every send is suppressed), and running it against a slot another
 * replica just enqueued is a suppressed send, not an error.
 *
 * @param ctx - database, logger, clock and `enqueue`. The clock is read once, so
 *   every page of a run makes the same window decision.
 */
export async function sweepSettlements(
  ctx: EnqueueContext,
  limits: SettlementSweepLimits = {},
): Promise<SettlementSweepSummary> {
  const batchSize = limits.batchSize ?? SETTLEMENT_SWEEP_BATCH_SIZE;
  const maxBatches = limits.maxBatches ?? SETTLEMENT_SWEEP_MAX_BATCHES;
  const cap = batchSize * maxBatches;

  // One instant for the whole run.
  const now = ctx.now();

  const eligible = {
    status: SlotStatus.IN_PROGRESS,
    deletedAt: null,
    settlementEndsAt: { gt: now },
  } as const;

  let offset = 0;
  let scanned = 0;
  let enqueued = 0;
  let suppressed = 0;
  let exhausted = false;

  while (scanned < cap) {
    const take = Math.min(batchSize, cap - scanned);

    const page = await ctx.db.campaignCreatorSlot.findMany({
      where: eligible,
      orderBy: settlementSweepOrderBy(),
      skip: offset,
      take,
      select: { id: true },
    });

    if (page.length === 0) {
      exhausted = true;
      break;
    }

    for (const slot of page) {
      scanned += 1;

      const jobId = await ctx.enqueue(
        SETTLE_SLOT_QUEUE,
        { slotId: slot.id },
        {
          singletonKey: settleSingletonKey(slot.id),
          singletonSeconds: SETTLE_SLOT_SINGLETON_SECONDS,
        },
      );

      if (jobId === null) {
        suppressed += 1;
      } else {
        enqueued += 1;
      }
    }

    offset += page.length;

    // A short page means the eligible set is exhausted, not that the budget ran
    // out: only then is the answer "there is nothing beyond the cap".
    if (page.length < take) {
      exhausted = true;
      break;
    }
  }

  // Truncation is measured, not guessed: one row past the cap is the exact
  // answer and cheaper than a count. Asking for it only when the run actually
  // filled its budget keeps the common case at one statement.
  let truncated = false;
  if (!exhausted && scanned >= cap) {
    const beyond = await ctx.db.campaignCreatorSlot.findMany({
      where: eligible,
      orderBy: settlementSweepOrderBy(),
      skip: offset,
      take: 1,
      select: { id: true },
    });
    truncated = beyond.length > 0;
  }

  if (truncated) {
    // Warn, not debug: every run that reports this is a run that left work
    // behind, and if it keeps happening the backlog never drains (OQ-9).
    ctx.logger.warn('settlement.sweep: stopped at its budget', {
      scanned,
      enqueued,
      suppressed,
      cap,
    });
  }

  if (suppressed > 0) {
    // Counts only: which slot was already queued is per-slot detail (R6).
    ctx.logger.debug('settlement.sweep: some sends were suppressed', {
      scanned,
      enqueued,
      suppressed,
    });
  }

  return { scanned, enqueued, suppressed, truncated };
}
