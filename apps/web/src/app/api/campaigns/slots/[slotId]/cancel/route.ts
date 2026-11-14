// apps/web/src/app/api/campaigns/slots/[slotId]/cancel/route.ts
//
// POST /api/campaigns/slots/[slotId]/cancel — a brand cancels a slot that has
// not started yet. ADR-0003 state machine: INVITED or ACCEPTED -> CANCELLED,
// actor = org OWNER or ADMIN.
//
// Cancelling only frees the escrow the slot was holding: an INVITED or ACCEPTED
// slot has paid nothing, so no PayoutEvent is written and no money moves.
// CANCELLED is already in FREED_ESCROW_STATUSES, so the campaign's next invite
// sees that budget available again. Like decline, cancel has NO
// ACTIVE-campaign precondition: the transition can only reduce committed
// escrow, never overspend a budget, so the campaign row is not locked.
//
// A slot cannot be cancelled once content is submitted (the brand rejects
// instead, sending it back to ACCEPTED) or after approval (the BASELINE has
// been paid; only a dispute is possible).
//
// Security:
// - A non-member, a member of a soft-deleted organization and an unknown slot
//   all get the identical 404, so neither slot ids nor org membership can be
//   probed. A MEMBER-role caller gets the shared 403. All permission checks go
//   through the one shared helper (ADR-0003 invariant 6).
// - The request body is never read or parsed: there is nothing for a client to
//   set, so a body is ignored rather than trusted.
// - The status change is one compare-and-swap updateMany whose WHERE uses only
//   scalar columns of the slot row; see the comment above it (invariant 1).
// - Logs carry ids only: never emails, amounts or tokens.
//
// Request order: auth -> provision -> slot id (404) -> slot load (404) ->
// soft-deleted campaign (404) -> org access/role (404/403) -> self-action guard
// (403) -> cancellable status (409) -> compare-and-swap (409) -> re-read (409)
// -> 200.
//
import { SlotStatus, prisma } from '@repo/database';
import { requireAuthApi } from '@/lib/auth/require-auth';
import {
  ORG_MANAGER_ROLES,
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
  requireOrgRole,
} from '@/lib/auth/org-access';
import { noStoreJson } from '@/lib/http/json';
import { CANCELLABLE_SLOT_STATUSES } from '@/lib/slots/constants';
import { SlotIdParamSchema } from '@/lib/slots/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notFound() {
  return noStoreJson({ error: 'Not found' }, 404);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slotId: string }> },
) {
  try {
    const authResult = await requireAuthApi();
    if (!authResult.ok) return authResult.response;

    const user = await provisionedUserOrResponse(authResult.userId);
    if (!user.ok) return user.response;

    const parsedSlotId = SlotIdParamSchema.safeParse((await params).slotId);
    if (!parsedSlotId.success) return notFound();

    const slot = await prisma.campaignCreatorSlot.findFirst({
      where: { id: parsedSlotId.data, deletedAt: null },
      select: {
        id: true,
        status: true,
        creator: { select: { userId: true } },
        campaign: {
          select: { id: true, deletedAt: true, organizationId: true },
        },
      },
    });
    if (slot === null) return notFound();

    // A slot in a soft-deleted campaign is gone for every caller, including a
    // member: answered before authorization so it cannot reveal the slot.
    if (slot.campaign.deletedAt !== null) return notFound();

    const access = await getOrgAccess(user.userId, slot.campaign.organizationId);
    if (!access.ok) return orgAccessErrorResponse(access.reason);

    const allowed = requireOrgRole(access, ORG_MANAGER_ROLES);
    if (!allowed.ok) return orgAccessErrorResponse(allowed.reason);

    // A creator who is also an OWNER/ADMIN of the campaign's organization must
    // not cancel their own slot. Runs after the membership check, so a
    // non-member never sees this reason, and before the status check and any
    // write, so a blocked request touches nothing.
    if (slot.creator.userId === user.userId) {
      return noStoreJson(
        {
          error: 'You cannot cancel your own slot',
          code: 'SELF_ACTION_NOT_ALLOWED',
        },
        403,
      );
    }

    if (!CANCELLABLE_SLOT_STATUSES.some((status) => status === slot.status)) {
      // No current status and no other slot data: the caller learns only that
      // the transition is not available.
      return noStoreJson(
        {
          error: 'Slot cannot be cancelled in its current state',
          code: 'SLOT_NOT_CANCELLABLE',
        },
        409,
      );
    }

    const now = new Date();
    // The WHERE clause deliberately uses only scalar columns of the slot row
    // so the status guard is applied atomically in a single UPDATE. A relation
    // filter here is not guaranteed to be applied atomically with the write
    // and can lose the guard under concurrency. Campaign state is not a
    // precondition for cancel (it only frees escrow), so it is not read here.
    const result = await prisma.campaignCreatorSlot.updateMany({
      where: {
        id: slot.id,
        deletedAt: null,
        status: { in: [...CANCELLABLE_SLOT_STATUSES] },
      },
      data: {
        status: SlotStatus.CANCELLED,
        cancelledAt: now,
      },
    });

    if (result.count === 0) {
      return noStoreJson(
        { error: 'Slot changed. Reload and retry.', code: 'SLOT_CONFLICT' },
        409,
      );
    }

    const row = await prisma.campaignCreatorSlot.findFirst({
      where: { id: slot.id, deletedAt: null },
      select: { id: true, status: true, cancelledAt: true },
    });
    if (row === null) {
      return noStoreJson(
        { error: 'Slot changed. Reload and retry.', code: 'SLOT_CONFLICT' },
        409,
      );
    }

    console.info('[slots] cancelled', {
      slotId: slot.id,
      campaignId: slot.campaign.id,
      cancelledByUserId: user.userId,
    });

    return noStoreJson({
      id: row.id,
      status: row.status,
      cancelledAt:
        row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
    });
  } catch (error) {
    console.error('[slots] cancel failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
