// apps/web/src/lib/slots/constants.ts
//
// Single source of truth for slot timing rules that more than one module reads
// (the approve route writes them, the settlement worker honours them), so the
// written value and the enforced window cannot drift apart.

import { SlotStatus } from '@repo/database';

/**
 * How long a slot keeps settling after the brand approves its content. At
 * expiry the settlement worker runs once and closes the slot (ADR-0003 D4).
 * Stored per slot in `settlementEndsAt` at approval, never recomputed on read.
 */
export const SETTLEMENT_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Absolute end of the settlement window for a slot approved at `approvedAt`.
 *
 * The window is a fixed duration, not a calendar interval: plain UTC
 * millisecond addition, so there is no local-time offset and no DST jump. A
 * 30-day window is always exactly 30 * 24 * 60 * 60 * 1000 ms after approval.
 */
export function settlementEndsAtFrom(approvedAt: Date): Date {
  return new Date(approvedAt.getTime() + SETTLEMENT_WINDOW_DAYS * MS_PER_DAY);
}

/**
 * The slot states a brand may cancel, per the ADR-0003 state machine:
 * INVITED or ACCEPTED -> CANCELLED, by an org OWNER or ADMIN.
 *
 * A slot cannot be cancelled once content is submitted: the brand rejects the
 * submission instead, which returns the slot to ACCEPTED for a resubmission.
 * It cannot be cancelled after approval either, because the BASELINE has
 * already been paid by then - the only remaining exit is a dispute.
 */
export const CANCELLABLE_SLOT_STATUSES = [
  SlotStatus.INVITED,
  SlotStatus.ACCEPTED,
] as const;
