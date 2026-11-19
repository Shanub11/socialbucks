// apps/web/src/lib/invites/schemas.ts
//
// Zod schema for creating an invite (POST .../invites).
//
// The body is strict: creatorId, status, metric, platform, inviteExpiresAt,
// organizationId and id are all rejected, because every one of those is decided
// by the server. Escrow enters as a decimal string (a JSON number fails) and is
// converted straight to Prisma.Decimal; `viewTarget` is a plain integer count of
// views, not money.

import { Prisma } from '@repo/database';
import { z } from 'zod';

import { CampaignBudgetSchema } from '@/lib/campaigns/schemas';
import { toMinorUnits } from '@/lib/settlement/money';

import { MAX_VIEW_TARGET, MIN_SLOT_ESCROW, MIN_VIEW_TARGET } from './constants';

/** The minimum escrow, in bigint minor units, computed once at module load. */
const MIN_ESCROW_MINOR = toMinorUnits(new Prisma.Decimal(MIN_SLOT_ESCROW));

/** Normalizes (trim + lowercase) before validating the address shape. */
export const InviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

/**
 * Reuses the campaign budget rules (decimal string, at most 2dp, > 0) and
 * additionally requires the slot minimum — compared in minor units so no
 * floating-point rounding can let 4.99 through.
 */
export const SlotEscrowSchema = CampaignBudgetSchema.refine(
  (amount) => toMinorUnits(amount) >= MIN_ESCROW_MINOR,
  `Escrow must be at least ${MIN_SLOT_ESCROW}`,
);

/** A count of views: a whole number in the accepted band, never a string. */
export const ViewTargetSchema = z
  .number()
  .int()
  .min(MIN_VIEW_TARGET)
  .max(MAX_VIEW_TARGET);

export const CreateInviteBodySchema = z.strictObject({
  creatorEmail: InviteEmailSchema,
  escrowAmount: SlotEscrowSchema,
  viewTarget: ViewTargetSchema,
});

export type CreateInviteBody = z.infer<typeof CreateInviteBodySchema>;
