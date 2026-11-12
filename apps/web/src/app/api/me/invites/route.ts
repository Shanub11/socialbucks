// apps/web/src/app/api/me/invites/route.ts
//
// GET /api/me/invites — list the authenticated creator's pending invites.
//
// Only invites that are still actionable are returned: status INVITED, not
// expired, on an active campaign in a live organization. A user with no
// creator profile gets an empty list — they have no invites.
//
import { CampaignStatus, SlotStatus, prisma } from '@repo/database';
import { DEFAULT_PAGE_SIZE } from '@/lib/orgs/constants';
import { provisionedUserOrResponse } from '@/lib/auth/org-access';
import { requireAuthApi } from '@/lib/auth/require-auth';
import { getCreatorIdForUser } from '@/lib/slots/creator-access';
import { ListMyInvitesQuerySchema } from '@/lib/slots/schemas';
import { CREATOR_SLOT_SELECT, serializeCreatorSlot } from '@/lib/slots/serialize';
import { noStoreJson, parseQuery } from '@/lib/http/json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const authResult = await requireAuthApi();
    if (!authResult.ok) return authResult.response;

    const user = await provisionedUserOrResponse(authResult.userId);
    if (!user.ok) return user.response;

    const query = parseQuery(req, ListMyInvitesQuerySchema);
    if (!query.ok) return query.response;

    const creatorId = await getCreatorIdForUser(user.userId);
    if (creatorId === null) {
      return noStoreJson({ items: [], nextCursor: null });
    }

    const limit = query.data.limit ?? DEFAULT_PAGE_SIZE;
    const now = new Date();

    if (query.data.cursor !== undefined) {
      const cursorSlot = await prisma.campaignCreatorSlot.findFirst({
        where: { id: query.data.cursor, creatorId, deletedAt: null },
        select: { id: true },
      });
      if (!cursorSlot) {
        return noStoreJson({ error: 'Invalid cursor' }, 400);
      }
    }

    const rows = await prisma.campaignCreatorSlot.findMany({
      where: {
        creatorId,
        deletedAt: null,
        status: SlotStatus.INVITED,
        inviteExpiresAt: { gt: now },
        campaign: {
          deletedAt: null,
          status: CampaignStatus.ACTIVE,
          organization: { deletedAt: null },
        },
      },
      orderBy: [{ invitedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.data.cursor ? { cursor: { id: query.data.cursor }, skip: 1 } : {}),
      select: CREATOR_SLOT_SELECT,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last !== undefined ? last.id : null;

    return noStoreJson({
      items: page.map((row) => serializeCreatorSlot(row)),
      nextCursor,
    });
  } catch (error) {
    console.error('[slots] list invites failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}