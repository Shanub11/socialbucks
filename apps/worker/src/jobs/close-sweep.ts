// apps/worker/src/jobs/close-sweep.ts
//
// The window-close sweep: find the slots whose settlement window has ended and
// hand each one to a close job (ADR-0006 D10, ADR-0004 D2).
//
// It is the exact complement of `sweepSettlements`, and the pair splits the
// table with no overlap and no gap:
//
//   settlement.sweep   settlementEndsAt >  now()   -> a final read while open
//   settlement.close-sweep  settlementEndsAt <= now()   -> close the window
//
// A window ending exactly at `now` belongs to the close sweep, which is why
// this predicate is `lte` and the settle sweep's is `gt`. A NULL window is
// selected by NEITHER: `lte` is a comparison and SQL comparisons never match
// NULL, so no `not: null` clause is needed here - the semantics of the
// comparison are the guarantee. (The pure test asserts the where clause
// literally, so adding a clause would be a visible decision, not a silent one.)
//
// The other two clauses are load-bearing in the same way as the settle sweep:
//
//   status: IN_PROGRESS  - only an accepted, running slot has a window to end.
//                          DISPUTED, CLOSED, COMPLETED, CANCELLED and the
//                          pre-acceptance states are never enqueued.
//   deletedAt: null      - closing is a state change on live work.
//
// Closing moves NO money (ADR-0004 D2): it writes `status = CLOSED` and
// `closedAt`, never `escrowAmount`, never `paidToDate`, never a PayoutEvent.
// The slot keeps counting its full escrow against the campaign committed total.
//
// Like the settle sweep this carries no progress between runs. The order is
// `settlementEndsAt ASC, id ASC` - oldest window first - so a slot behind the
// budget in one run is at the front of the next. The same limitation as OQ-9
// applies and is recorded as OQ-11: a slot that can never be closed (its final
// read never succeeds) keeps its old window and its place at the front.
//
// Bounded like every other job (R3): 100 ids per statement, 20 statements per
// run, 2,000 slots.

import { SlotStatus } from '@repo/database';

import type { EnqueueContext } from './context';
import { CLOSE_SLOT_QUEUE, CLOSE_SLOT_SINGLETON_SECONDS } from './queues';
import { SETTLEMENT_SWEEP_BATCH_SIZE, SETTLEMENT_SWEEP_MAX_BATCHES } from './sweep-settlements';

/**
 * The close sweep's total order, in one place so the pages and the truncation
 * probe cannot drift apart. Oldest window first: the slot that has waited
 * longest to be closed goes first, and a cut-off slot leads the next run.
 */
export type CloseSweepOrderBy = Array<{ settlementEndsAt: 'asc' } | { id: 'asc' }>;

export function closeSweepOrderBy(): CloseSweepOrderBy {
  return [{ settlementEndsAt: 'asc' }, { id: 'asc' }];
}

export interface CloseSweepSummary {
  /** Slots the sweep considered, before any dedupe by pg-boss. */
  scanned: number;
  /** Slots a job was actually inserted for (the send returned an id). */
  enqueued: number;
  /** Sends pg-boss suppressed: the slot already had a close job in this bucket. */
  suppressed: number;
  /** True when the run stopped at its budget instead of running out of work. */
  truncated: boolean;
}

/** Injectable bounds; the tests narrow them so the cap is provable. */
export interface CloseSweepLimits {
  batchSize?: number;
  maxBatches?: number;
}

/** The singleton key for one slot's close job. Never the settle key. */
export function closeSingletonKey(slotId: string): string {
  return `close:${slotId}`;
}

/**
 * Enqueues one close job per ended slot, at most once per slot per bucket.
 *
 * Writes nothing: it hands work off. Idempotent (R4) - a second run in the same
 * bucket suppresses every send, and a send another replica already made is a
 * suppressed send, not an error.
 *
 * @param ctx - database, logger, clock and `enqueue`. The clock is read once,
 *   so every page of a run makes the same window decision.
 */
export async function closeSweep(
  ctx: EnqueueContext,
  limits: CloseSweepLimits = {},
): Promise<CloseSweepSummary> {
  const batchSize = limits.batchSize ?? SETTLEMENT_SWEEP_BATCH_SIZE;
  const maxBatches = limits.maxBatches ?? SETTLEMENT_SWEEP_MAX_BATCHES;
  const cap = batchSize * maxBatches;

  // One instant for the whole run.
  const now = ctx.now();

  const eligible = {
    status: SlotStatus.IN_PROGRESS,
    deletedAt: null,
    settlementEndsAt: { lte: now },
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
      orderBy: closeSweepOrderBy(),
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
        CLOSE_SLOT_QUEUE,
        { slotId: slot.id },
        {
          singletonKey: closeSingletonKey(slot.id),
          singletonSeconds: CLOSE_SLOT_SINGLETON_SECONDS,
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
  // answer. Asking only when the budget was actually filled keeps the common
  // case at one statement.
  let truncated = false;
  if (!exhausted && scanned >= cap) {
    const beyond = await ctx.db.campaignCreatorSlot.findMany({
      where: eligible,
      orderBy: closeSweepOrderBy(),
      skip: offset,
      take: 1,
      select: { id: true },
    });
    truncated = beyond.length > 0;
  }

  if (truncated) {
    // Warn, not debug: a run that reports this left work behind. If it keeps
    // happening, the backlog never drains (OQ-11).
    ctx.logger.warn('settlement.close-sweep: stopped at its budget', {
      scanned,
      enqueued,
      suppressed,
      cap,
    });
  }

  if (suppressed > 0) {
    ctx.logger.debug('settlement.close-sweep: some sends were suppressed', {
      scanned,
      enqueued,
      suppressed,
    });
  }

  return { scanned, enqueued, suppressed, truncated };
}
