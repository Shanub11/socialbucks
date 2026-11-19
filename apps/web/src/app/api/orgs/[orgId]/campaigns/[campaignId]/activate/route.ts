// apps/web/src/app/api/orgs/[orgId]/campaigns/[campaignId]/activate/route.ts
//
// POST /api/orgs/[orgId]/campaigns/[campaignId]/activate — publish a DRAFT
// campaign (OWNER/ADMIN only).
//
// Activation publishes the campaign but does NOT verify that the budget is
// funded: no payment partner exists yet (ADR-0003). ACTIVE currently means
// published-by-brand, not funded. The response carries fundingVerified: false
// until that changes.
//
// The request body is never read or parsed: there is nothing for a client to
// set, so a body is ignored rather than trusted.
//
// The transition is a compare-and-swap: the same preconditions checked above
// are re-checked inside the UPDATE's WHERE clause, so a change between the read
// and the write cannot activate an invalid campaign.

import { CampaignStatus, Prisma, prisma } from '@repo/database';

import {
  ORG_MANAGER_ROLES,
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
  requireOrgRole,
} from '@/lib/auth/org-access';
import { requireAuthApi } from '@/lib/auth/require-auth';
import { SUPPORTED_CAMPAIGN_CURRENCIES } from '@/lib/campaigns/constants';
import { CAMPAIGN_SELECT, serializeCampaign } from '@/lib/campaigns/serialize';
import { CampaignIdParamSchema } from '@/lib/campaigns/schemas';
import { noStoreJson } from '@/lib/http/json';
import { OrgIdParamSchema } from '@/lib/orgs/schemas';
import { MoneyError, assertTwoDecimalCurrency } from '@/lib/settlement/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
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

    const allowed = requireOrgRole(access, ORG_MANAGER_ROLES);
    if (!allowed.ok) return orgAccessErrorResponse(allowed.reason);

    const parsedCampaignId = CampaignIdParamSchema.safeParse(campaignId);
    if (!parsedCampaignId.success) {
      return orgAccessErrorResponse('NOT_FOUND');
    }

    const campaign = await prisma.campaign.findFirst({
      where: {
        id: parsedCampaignId.data,
        organizationId: allowed.organizationId,
        deletedAt: null,
      },
      select: CAMPAIGN_SELECT,
    });
    if (!campaign) return orgAccessErrorResponse('NOT_FOUND');

    if (campaign.status !== CampaignStatus.DRAFT) {
      return noStoreJson(
        { error: 'Campaign is not a draft', code: 'CAMPAIGN_NOT_DRAFT' },
        409,
      );
    }

    if (campaign.submissionDeadline === null) {
      return noStoreJson(
        {
          error: 'A submission deadline is required to activate',
          code: 'SUBMISSION_DEADLINE_REQUIRED',
        },
        422,
      );
    }

    if (campaign.submissionDeadline.getTime() <= Date.now()) {
      return noStoreJson(
        {
          error: 'The submission deadline has passed',
          code: 'SUBMISSION_DEADLINE_PASSED',
        },
        422,
      );
    }

    if (
      !SUPPORTED_CAMPAIGN_CURRENCIES.some(
        (supported) => supported === campaign.currency,
      )
    ) {
      return noStoreJson(
        { error: 'Unsupported currency', code: 'UNSUPPORTED_CURRENCY' },
        422,
      );
    }

    try {
      assertTwoDecimalCurrency(campaign.currency);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      return noStoreJson(
        { error: 'Unsupported currency', code: 'UNSUPPORTED_CURRENCY' },
        422,
      );
    }

    if (campaign.totalBudget.lte(new Prisma.Decimal(0))) {
      return noStoreJson(
        { error: 'Budget must be greater than zero', code: 'INVALID_BUDGET' },
        422,
      );
    }

    const now = new Date();

    // Compare-and-swap: the preconditions are re-checked here, so a concurrent
    // edit between the read above and this write cannot activate a campaign
    // that is no longer valid.
    const result = await prisma.campaign.updateMany({
      where: {
        id: campaign.id,
        organizationId: allowed.organizationId,
        status: CampaignStatus.DRAFT,
        deletedAt: null,
        submissionDeadline: { gt: now },
        totalBudget: { gt: new Prisma.Decimal(0) },
        currency: { in: [...SUPPORTED_CAMPAIGN_CURRENCIES] },
      },
      data: { status: CampaignStatus.ACTIVE },
    });

    if (result.count === 0) {
      return noStoreJson(
        {
          error: 'Campaign changed. Reload and retry.',
          code: 'CAMPAIGN_CONFLICT',
        },
        409,
      );
    }

    const row = await prisma.campaign.findFirst({
      where: {
        id: campaign.id,
        organizationId: allowed.organizationId,
        deletedAt: null,
      },
      select: CAMPAIGN_SELECT,
    });
    if (row === null) {
      return noStoreJson(
        {
          error: 'Campaign changed. Reload and retry.',
          code: 'CAMPAIGN_CONFLICT',
        },
        409,
      );
    }

    console.info('[campaigns] activated', {
      campaignId: row.id,
      organizationId: row.organizationId,
      userId: user.userId,
    });

    return noStoreJson({
      ...serializeCampaign(row),
      fundingVerified: false,
    });
  } catch (error) {
    console.error('[campaigns] activate failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
