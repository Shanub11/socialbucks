// apps/web/src/app/api/campaigns/slots/[slotId]/accept/route.ts
//
// POST /api/campaigns/slots/[slotId]/accept — creator accepts an invite.
//
// The request body is never read or parsed: there is nothing for a client to
// set, so a body is ignored rather than trusted.
//
// Every slot read/write includes creatorId (from the authenticated caller)
// and deletedAt: null. A slot that belongs to someone else, does not exist,
// is soft-deleted, or is requested by a user with no creator profile all
// return the identical 404 { error: 'Not found' }.
//
// The transition is a compare-and-swap: the pending status is re-checked
// inside the updateMany WHERE, so a change between the read and the write
// cannot slip through.
//
import { CampaignStatus, SlotStatus, SocialPlatform, prisma } from '@repo/database';
import { requireAuthApi } from '@/lib/auth/require-auth';
import { provisionedUserOrResponse } from '@/lib/auth/org-access';
import { getCreatorIdForUser } from '@/lib/slots/creator-access';
import { SlotIdParamSchema } from '@/lib/slots/schemas';
import { CREATOR_SLOT_SELECT, serializeCreatorSlot } from '@/lib/slots/serialize';
import { noStoreJson } from '@/lib/http/json';

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

    const creatorId = await getCreatorIdForUser(user.userId);
    if (creatorId === null) return notFound();

    const slot = await prisma.campaignCreatorSlot.findFirst({
      where: { id: parsedSlotId.data, creatorId, deletedAt: null },
      select: {
        id: true,
        status: true,
        inviteExpiresAt: true,
        campaign: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            submissionDeadline: true,
            organization: { select: { deletedAt: true } },
          },
        },
      },
    });
    if (!slot) return notFound();

    if (slot.status !== SlotStatus.INVITED) {
      return noStoreJson(
        { error: 'Invite is not pending', code: 'SLOT_NOT_INVITED' },
        409,
      );
    }

    if (
      slot.inviteExpiresAt === null ||
      slot.inviteExpiresAt.getTime() <= Date.now()
    ) {
      return noStoreJson(
        { error: 'The invite has expired', code: 'INVITE_EXPIRED' },
        409,
      );
    }

    const campaign = slot.campaign;
    if (
      campaign.deletedAt !== null ||
      campaign.organization.deletedAt !== null ||
      campaign.status !== CampaignStatus.ACTIVE
    ) {
      return noStoreJson(
        { error: 'Campaign is not active', code: 'CAMPAIGN_NOT_ACTIVE' },
        409,
      );
    }

    if (
      campaign.submissionDeadline === null ||
      campaign.submissionDeadline.getTime() <= Date.now()
    ) {
      return noStoreJson(
        { error: 'The submission deadline has passed', code: 'SUBMISSION_DEADLINE_PASSED' },
        409,
      );
    }

    const youtubeAccount = await prisma.socialAccount.findFirst({
      where: { creatorId, platform: SocialPlatform.YOUTUBE, revokedAt: null },
      select: { id: true },
    });
    if (youtubeAccount === null) {
      return noStoreJson(
        {
          error: 'Connect a YouTube account before accepting',
          code: 'YOUTUBE_ACCOUNT_REQUIRED',
        },
        409,
      );
    }

    const now = new Date();
    // The WHERE clause deliberately uses only scalar columns of the slot row
    // so the status guard is applied atomically in a single UPDATE. Campaign
    // state is validated in the pre-read above and re-validated at submit and
    // approve.
    const result = await prisma.campaignCreatorSlot.updateMany({
      where: {
        id: slot.id,
        creatorId,
        deletedAt: null,
        status: SlotStatus.INVITED,
        inviteExpiresAt: { gt: now },
      },
      data: { status: SlotStatus.ACCEPTED, acceptedAt: now },
    });

    if (result.count === 0) {
      return noStoreJson(
        { error: 'Invite changed. Reload and retry.', code: 'SLOT_CONFLICT' },
        409,
      );
    }

    const row = await prisma.campaignCreatorSlot.findFirst({
      where: { id: slot.id, creatorId, deletedAt: null },
      select: CREATOR_SLOT_SELECT,
    });
    if (!row) {
      return noStoreJson(
        { error: 'Invite changed. Reload and retry.', code: 'SLOT_CONFLICT' },
        409,
      );
    }

    console.info('[slots] accepted', {
      slotId: slot.id,
      campaignId: campaign.id,
    });
    return noStoreJson(serializeCreatorSlot(row));
  } catch (error) {
    console.error('[slots] accept failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}