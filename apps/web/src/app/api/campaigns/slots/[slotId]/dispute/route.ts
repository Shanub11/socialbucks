// apps/web/src/app/api/campaigns/slots/[slotId]/dispute/route.ts
//
// POST /api/campaigns/slots/[slotId]/dispute — brand-side dispute raise.
//
// Actors: org OWNER or ADMIN. Request order:
//   1. requireAuthApi
//   2. provisionedUserOrResponse(authResult.userId)
//   3. SlotIdParamSchema.safeParse((await params).slotId) -> 404
//   4. Load the slot with prisma.campaignCreatorSlot.findFirst(...)
//   5. slot.campaign.deletedAt !== null -> 404
//   6. getOrgAccess(user.userId, slot.campaign.organizationId) -> 404/403
//   7. requireOrgRole(access, ORG_MANAGER_ROLES) -> 404/403
//   8. Self-action guard: slot.creator.userId === user.userId -> 403
//   9. const body = await parseJsonBody(req, DisputeSlotBodySchema)
//   10. slot.status !== SlotStatus.IN_PROGRESS -> 409
//   11. CAS updateMany (scalar-only WHERE)
//   12. Re-read slot -> 409 if missing
//   13. console.info('[slots] disputed', { slotId, campaignId, raisedByUserId })
//   14. Return 200 with id, status, disputedAt (ISO)
//
// Security notes:
// - Body parsed after auth, org auth and self-action guard so unauthorized
//   callers learn nothing from the body (same as reject).
// - Reason never logged or echoed in errors/responses.
// - Settlement freezes automatically because settleSlot() skips any slot that is
//   not IN_PROGRESS; no money movement on dispute raise.
// - Resolution is operator-run per ADR-0004 D4, not part of this endpoint.
//
// References:
//   - ADR-0004 D3, D4
//   - patterns: reject and cancel routes
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
import { noStoreJson, parseJsonBody } from '@/lib/http/json';
import { DisputeSlotBodySchema } from '@/lib/slots/dispute-schemas';
import { SlotIdParamSchema } from '@/lib/slots/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notFound() {
  return noStoreJson({ error: 'Not found' }, 404);
}

export async function POST(
  req: Request,
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
          select: {
            id: true,
            deletedAt: true,
            organizationId: true,
          },
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

    // Self-action guard: a creator who is also an OWNER/ADMIN may not dispute their own slot.
    if (slot.creator.userId === user.userId) {
      return noStoreJson(
        {
          error: 'You cannot dispute your own slot',
          code: 'SELF_ACTION_NOT_ALLOWED',
        },
        403,
      );
    }

    const body = await parseJsonBody(req, DisputeSlotBodySchema);
    if (!body.ok) return body.response;

    if (slot.status !== SlotStatus.IN_PROGRESS) {
      return noStoreJson(
        {
          error: 'Slot cannot be disputed in its current state',
          code: 'SLOT_NOT_DISPUTABLE',
        },
        409,
      );
    }

    const now = new Date();
    // The WHERE clause deliberately uses only scalar columns of the slot row
    // so the status guard is applied atomically in a single UPDATE. A relation
    // filter here is not guaranteed to be applied atomically with the write
    // and can lose the guard under concurrency. Campaign state is not a
    // precondition for dispute (it only freezes settlement), so it is not read here.
    const result = await prisma.campaignCreatorSlot.updateMany({
      where: {
        id: slot.id,
        deletedAt: null,
        status: SlotStatus.IN_PROGRESS,
      },
      data: {
        status: SlotStatus.DISPUTED,
        disputedAt: now,
        disputeReason: body.data.reason,
        disputeRaisedByUserId: user.userId,
        // disputeResolvedAt: null is REQUIRED: a slot disputed before still carries
        // the earlier dispute's disputeResolvedAt, and the slot_dispute_resolved_order
        // CHECK ties it to disputedAt; setting it null here proves that transition
        // to DISPUTED does not yet resolve any earlier dispute.
        disputeResolvedAt: null,
      },
    });

    if (result.count === 0) {
      return noStoreJson(
        {
          error: 'Slot changed. Reload and retry.',
          code: 'SLOT_CONFLICT',
        },
        409,
      );
    }

    const row = await prisma.campaignCreatorSlot.findFirst({
      where: { id: slot.id, deletedAt: null },
      select: { id: true, status: true, disputedAt: true },
    });
    if (row === null) {
      return noStoreJson(
        {
          error: 'Slot changed. Reload and retry.',
          code: 'SLOT_CONFLICT',
        },
        409,
      );
    }

    console.info('[slots] disputed', {
      slotId: slot.id,
      campaignId: slot.campaign.id,
      raisedByUserId: user.userId,
    });

    return noStoreJson({
      id: row.id,
      status: row.status,
      disputedAt: row.disputedAt === null ? null : row.disputedAt.toISOString(),
    });
  } catch (error) {
    console.error('[slots] dispute failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}