// apps/worker/src/jobs/expire-invites.ts
//
// The first business job: expire invites whose window has passed (ADR-0004,
// ADR-0006 D1).
//
// The rule it implements is exactly ADR-0004's: expire the rows whose status is
// still INVITED when the clock has passed inviteExpiresAt. Nothing else. In
// particular:
//
//   - It writes `{ status: EXPIRED }` and nothing else. There is no expiredAt
//     column, and cancelledAt would claim a cancellation that never happened -
//     the slot was never cancelled, it simply ran out.
//
//   - It does NOT filter on deletedAt. `create-invite.ts` deliberately counts
//     soft-deleted slots in a campaign's committed escrow ("Soft-deleted slots
//     are deliberately NOT excluded: escrow may already have been committed"),
//     so a soft-deleted INVITED slot still holds budget. Excluding it here would
//     leave that escrow committed forever with no state that explains it.
//
//   - A NULL inviteExpiresAt never matches. `inviteExpiresAt: { lte: now }`
//     compiles to a comparison, and NULL is not less than anything; the explicit
//     `not: null` states the intent so a future refactor cannot drop it.
//
//   - The write is a compare-and-swap: the WHERE clause repeats the read's
//     condition, so a slot the creator accepted between the select and the
//     update is left alone. Losing that race is normal, not an error.
//
// Everything is bounded (R2): at most INVITE_EXPIRY_BATCH_SIZE rows per
// statement and INVITE_EXPIRY_MAX_BATCHES statements per run. A backlog drains
// over several runs; a single run never holds a long transaction, and the
// [status, inviteExpiresAt] index keeps each statement a short index scan.

import { SlotStatus } from '@repo/database';

import type { JobContext } from './context';

/** Rows per SELECT and per UPDATE. Small enough to keep both statements short. */
export const INVITE_EXPIRY_BATCH_SIZE = 100;

/** Statements per run: 20 x 100 = 2,000 invites per sweep at most. */
export const INVITE_EXPIRY_MAX_BATCHES = 20;

export interface ExpireInvitesSummary {
  /** Invites the SELECT returned, before the CAS. */
  scanned: number;
  /** Invites this run actually moved to EXPIRED. */
  expired: number;
  /** True when the run stopped at its budget instead of running out of work. */
  truncated: boolean;
}

/**
 * Injectable bounds. Production uses the constants above; the tests pass a
 * batchSize of 2 so the bound can be proven without 2,001 fixture rows.
 */
export interface ExpireInvitesLimits {
  batchSize?: number;
  maxBatches?: number;
}

/**
 * Expires every INVITED slot whose invite window ended at or before `now`.
 *
 * Idempotent (R3): a second run over the same data finds nothing to do. Safe to
 * run concurrently with itself and with the accept/decline routes, because the
 * only write is a CAS on the same predicate the read used.
 *
 * @param ctx - database, logger and clock; the clock is read exactly once, so a
 *   run that straddles a second boundary still makes one consistent decision.
 */
export async function expireInvites(
  ctx: JobContext,
  limits: ExpireInvitesLimits = {},
): Promise<ExpireInvitesSummary> {
  const batchSize = limits.batchSize ?? INVITE_EXPIRY_BATCH_SIZE;
  const maxBatches = limits.maxBatches ?? INVITE_EXPIRY_MAX_BATCHES;

  // One instant for the whole run: every statement and the CAS use `now`.
  const now = ctx.now();

  let remaining = batchSize * maxBatches;
  let scanned = 0;
  let expired = 0;

  while (remaining > 0) {
    const take = Math.min(batchSize, remaining);

    const candidates = await ctx.db.campaignCreatorSlot.findMany({
      where: {
        status: SlotStatus.INVITED,
        inviteExpiresAt: { not: null, lte: now },
      },
      // Oldest first, so a backlog drains in the order it piled up.
      orderBy: { inviteExpiresAt: 'asc' },
      take,
      select: { id: true },
    });

    if (candidates.length === 0) break;

    const ids = candidates.map((slot) => slot.id);
    scanned += ids.length;
    remaining -= ids.length;

    const result = await ctx.db.campaignCreatorSlot.updateMany({
      // The same predicate as the read, plus the ids. This is the CAS: a slot
      // accepted (or declined, or cancelled) since the SELECT no longer matches
      // and is left untouched.
      where: {
        id: { in: ids },
        status: SlotStatus.INVITED,
        inviteExpiresAt: { not: null, lte: now },
      },
      // Status only. escrowAmount, the immutable terms and every timestamp are
      // evidence for a dispute and are never rewritten by an expiry.
      data: { status: SlotStatus.EXPIRED },
    });

    expired += result.count;

    if (result.count < ids.length) {
      // Counts only: which slot lost the race is a per-slot detail that would
      // turn one log line per sweep into one per slot (R6).
      ctx.logger.debug('invites.expire: some candidates changed before the update', {
        candidates: ids.length,
        expired: result.count,
      });
    }

    // A short page means the queue of expired invites is empty, not that the
    // budget ran out.
    if (candidates.length < take) break;
  }

  // Truncation is only claimed when there is still work: the cheaper guess -
  // "the budget ran out, so there must be more" - reports a truncation on every
  // run that happens to end on an exact multiple of the budget.
  let truncated = false;
  if (remaining === 0) {
    const left = await ctx.db.campaignCreatorSlot.count({
      where: {
        status: SlotStatus.INVITED,
        inviteExpiresAt: { not: null, lte: now },
      },
    });
    truncated = left > 0;
  }

  return { scanned, expired, truncated };
}
