// apps/web/src/lib/creator/format.ts
//
// Display formatting for the creator workspace. Pure functions only, and the
// only import is a type: the pages render these on the server, and tests import
// them without pulling the Prisma client (and its pool) into the test process.

import type { SlotStatus } from '@repo/database';

/**
 * Human labels for every slot status.
 *
 * `Record<SlotStatus, string>` is the point: adding a value to the enum without
 * a label here fails the type check instead of rendering a blank status chip.
 */
export const SLOT_STATUS_LABEL: Record<SlotStatus, string> = {
  INVITED: 'Invited',
  ACCEPTED: 'Accepted',
  CONTENT_SUBMITTED: 'Content submitted',
  CONTENT_APPROVED: 'Content approved',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  DISPUTED: 'Disputed',
  CANCELLED: 'Cancelled',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
  CLOSED: 'Closed',
};

/** The label for one status. Total by construction, never a fallback string. */
export function slotStatusLabel(status: SlotStatus): string {
  return SLOT_STATUS_LABEL[status];
}

/**
 * The statuses that count as an active collaboration: a slot is live from
 * acceptance until settlement closes it. INVITED is not active (the creator has
 * not agreed yet), and CLOSED/COMPLETED/DISPUTED are past or paused.
 */
export const ACTIVE_SLOT_STATUSES: readonly SlotStatus[] = [
  'ACCEPTED',
  'CONTENT_SUBMITTED',
  'CONTENT_APPROVED',
  'IN_PROGRESS',
];

/**
 * Money for display, in the campaign's own currency.
 *
 * `en-IN` grouping with no explicit fraction digits: `Intl` then uses the
 * currency's minor units (2 for INR and USD, 0 for JPY), so a half-rupee is
 * shown, never rounded away. `Number()` is for display only; callers keep the
 * `Decimal` for anything that is computed.
 *
 * An unknown currency code makes `Intl` throw a `RangeError`. Formatting a
 * number is not worth failing a page over, so that falls back to the raw
 * amount and code.
 */
export function formatMoney(amount: number | string, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(
      Number(amount),
    );
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * The handle to show for a connected account.
 *
 * Stored handles are not normalised across providers (YouTube has none at all
 * and Instagram may or may not include the `@`), so: trim, show a handle with
 * exactly one leading `@` when there is one, else the trimmed display name,
 * else the caller's label for "connected, but we have nothing to call it".
 */
export function displayHandle(
  handle: string | null,
  displayName: string | null,
  fallback: string,
): string {
  const trimmedHandle = handle?.trim() ?? '';

  if (trimmedHandle.length > 0) {
    return trimmedHandle.startsWith('@') ? trimmedHandle : `@${trimmedHandle}`;
  }

  const trimmedName = displayName?.trim() ?? '';

  if (trimmedName.length > 0) {
    return trimmedName;
  }

  return fallback;
}
