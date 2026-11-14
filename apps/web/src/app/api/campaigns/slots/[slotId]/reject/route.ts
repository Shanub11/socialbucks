// apps/web/src/app/api/campaigns/slots/[slotId]/reject/route.ts
//
// POST /api/campaigns/slots/[slotId]/reject — the brand rejects submitted
// content with a reason, returning the slot to ACCEPTED so the creator can
// submit again.
//
// Security:
// - The reason is parsed only AFTER authentication, org authorization and the
//   self-action guard, so an unauthorized caller learns nothing from the body.
// - The reason is never logged. Logs carry ids only.
// - The status change is one compare-and-swap updateMany; see the comment
//   above it.
//
import { CampaignStatus, SlotStatus, prisma } from '@repo/database';
import { requireAuthApi } from '@/lib/auth/require-auth';
import {
  ORG_MANAGER_ROLES,
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
  requireOrgRole,
} from '@/lib/auth/org-access';
import { noStoreJson, parseJsonBody } from '@/lib/http/json';
import { RejectSlotBodySchema } from '@/lib/slots/reject-schemas';
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
            status: true,
            deletedAt: true,
            organizationId: true,
          },
        },
      },
    });
    if (slot === null) return notFound();

    const access = await getOrgAccess(user.userId, slot.campaign.organizationId);
    if (!access.ok) return orgAccessErrorResponse(access.reason);

    const allowed = requireOrgRole(access, ORG_MANAGER_ROLES);
    if (!allowed.ok) return orgAccessErrorResponse(allowed.reason);

    if (slot.creator.userId === user.userId) {
      return noStoreJson(
        {
          error: 'You cannot reject your own content',
          code: 'SELF_ACTION_NOT_ALLOWED',
        },
        403,
      );
    }

    const body = await parseJsonBody(req, RejectSlotBodySchema);
    if (!body.ok) return body.response;

    if (
      slot.campaign.deletedAt !== null ||
      slot.campaign.status !== CampaignStatus.ACTIVE
    ) {
      return noStoreJson(
        { error: 'Campaign is not active', code: 'CAMPAIGN_NOT_ACTIVE' },
        409,
      );
    }

    if (slot.status !== SlotStatus.CONTENT_SUBMITTED) {
      return noStoreJson(
        {
          error: 'Content has not been submitted for review',
          code: 'SLOT_NOT_SUBMITTED',
        },
        409,
      );
    }

    const now = new Date();
    // The WHERE clause deliberately uses only scalar columns of the slot row
    // so the status guard is applied atomically in a single UPDATE. A relation
    // filter here is not guaranteed to be applied atomically with the write
    // and can lose the guard under concurrency. Campaign state is validated in
    // the pre-read above.
    const result = await prisma.campaignCreatorSlot.updateMany({
      where: {
        id: slot.id,
        deletedAt: null,
        status: SlotStatus.CONTENT_SUBMITTED,
      },
      data: {
        status: SlotStatus.ACCEPTED,
        rejectedAt: now,
        rejectionReason: body.data.reason,
      },
    });

    if (result.count === 0) {
      return noStoreJson(
        {
          error: 'Submission changed. Reload and retry.',
          code: 'SLOT_CONFLICT',
        },
        409,
      );
    }

    const row = await prisma.campaignCreatorSlot.findFirst({
      where: { id: slot.id, deletedAt: null },
      select: {
        id: true,
        status: true,
        rejectedAt: true,
        rejectionReason: true,
      },
    });
    if (row === null) {
      return noStoreJson(
        {
          error: 'Submission changed. Reload and retry.',
          code: 'SLOT_CONFLICT',
        },
        409,
      );
    }

    console.info('[slots] rejected', {
      slotId: slot.id,
      campaignId: slot.campaign.id,
      rejectedByUserId: user.userId,
    });

    return noStoreJson({
      id: row.id,
      status: row.status,
      rejectedAt: row.rejectedAt === null ? null : row.rejectedAt.toISOString(),
      rejectionReason: row.rejectionReason,
    });
  } catch (error) {
    console.error('[slots] reject failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
