// apps/web/src/app/api/orgs/[orgId]/campaigns/[campaignId]/route.ts
//
// GET /api/orgs/[orgId]/campaigns/[campaignId] — read one campaign. Any member
// of the organization may read it.
//
// A campaign is never loaded by its id alone: the query is scoped to the org
// from the verified access result and to live (non-deleted) rows. Non-member,
// foreign campaign, unknown id, soft-deleted campaign, soft-deleted org and
// malformed id are all the same 404 so ids cannot be probed.

import { prisma } from '@repo/database';

import {
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
} from '@/lib/auth/org-access';
import { requireAuthApi } from '@/lib/auth/require-auth';
import { CAMPAIGN_SELECT, serializeCampaign } from '@/lib/campaigns/serialize';
import { CampaignIdParamSchema } from '@/lib/campaigns/schemas';
import { noStoreJson } from '@/lib/http/json';
import { OrgIdParamSchema } from '@/lib/orgs/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; campaignId: string }> },
) {
  try {
    const authResult = await requireAuthApi();
    if (!authResult.ok) return authResult.response;

    const user = await provisionedUserOrResponse(authResult.userId);
    if (!user.ok) return user.response;

    // This version of Next.js passes route params as a Promise.
    const { orgId, campaignId } = await params;

    const parsedOrgId = OrgIdParamSchema.safeParse(orgId);
    if (!parsedOrgId.success) return orgAccessErrorResponse('NOT_FOUND');

    const access = await getOrgAccess(user.userId, parsedOrgId.data);
    if (!access.ok) return orgAccessErrorResponse(access.reason);

    const parsedCampaignId = CampaignIdParamSchema.safeParse(campaignId);
    if (!parsedCampaignId.success) {
      return orgAccessErrorResponse('NOT_FOUND');
    }

    const campaign = await prisma.campaign.findFirst({
      where: {
        id: parsedCampaignId.data,
        organizationId: access.organizationId,
        deletedAt: null,
      },
      select: CAMPAIGN_SELECT,
    });
    if (!campaign) return orgAccessErrorResponse('NOT_FOUND');

    return noStoreJson(serializeCampaign(campaign));
  } catch (error) {
    console.error('[campaigns] get campaign failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
