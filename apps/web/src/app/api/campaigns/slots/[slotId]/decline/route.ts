// apps/web/src/app/api/campaigns/slots/[slotId]/decline/route.ts
//
// POST /api/campaigns/slots/[slotId]/decline — creator declines an invite.
//
// The request body is never read or parsed: there is nothing for a client to
// set, so a body is ignored rather than trusted.
//
// Decline deliberately has NO expiry, campaign-state or deadline
// precondition: declining always frees the committed escrow, so it is always
// allowed on a pending invite. The only gate is that the slot is INVITED.
//
import { SlotStatus, prisma } from '@repo/database';
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
      select: { id: true, status: true, campaignId: true },
    });
    if (!slot) return notFound();

    if (slot.status !== SlotStatus.INVITED) {
      return noStoreJson(
        { error: 'Invite is not pending', code: 'SLOT_NOT_INVITED' },
        409,
      );
    }

    const now = new Date();
    const result = await prisma.campaignCreatorSlot.updateMany({
      where: {
        id: slot.id,
        creatorId,
        deletedAt: null,
        status: SlotStatus.INVITED,
      },
      data: { status: SlotStatus.DECLINED, declinedAt: now },
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

    console.info('[slots] declined', {
      slotId: slot.id,
      campaignId: slot.campaignId,
    });
    return noStoreJson(serializeCreatorSlot(row));
  } catch (error) {
    console.error('[slots] decline failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}