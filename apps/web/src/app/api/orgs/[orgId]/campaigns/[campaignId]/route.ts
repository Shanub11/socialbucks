// apps/web/src/app/api/orgs/[orgId]/campaigns/[campaignId]/route.ts
//
// GET /api/orgs/[orgId]/campaigns/[campaignId] — read one campaign. Any member
// of the organization may read it.
//
// A campaign is never loaded by its id alone: the query is scoped to the org
// from the verified access result and to live (non-deleted) rows. Non-member,
// foreign campaign, unknown id, soft-deleted campaign, soft-deleted org and
// malformed id are all the same 404 so ids cannot be probed.

import { CampaignStatus, Prisma, prisma } from '@repo/database';

import {
  ORG_MANAGER_ROLES,
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
  requireOrgRole,
} from '@/lib/auth/org-access';
import { requireAuthApi } from '@/lib/auth/require-auth';
import { CAMPAIGN_SELECT, type CampaignRow, serializeCampaign } from '@/lib/campaigns/serialize';
import { CampaignIdParamSchema } from '@/lib/campaigns/schemas';
import { UpdateCampaignBodySchema } from '@/lib/campaigns/update-schemas';
import { noStoreJson, parseJsonBody } from '@/lib/http/json';
import { OrgIdParamSchema } from '@/lib/orgs/schemas';
import { MoneyError, assertTwoDecimalCurrency } from '@/lib/settlement/money';

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

type UpdateCampaignOutcome =
  | { kind: 'has_slots' }
  | { kind: 'conflict' }
  | { kind: 'updated'; row: CampaignRow };

export async function PATCH(
  req: Request,
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

    const existing = await prisma.campaign.findFirst({
      where: {
        id: parsedCampaignId.data,
        organizationId: allowed.organizationId,
        deletedAt: null,
      },
      select: { id: true, status: true },
    });
    if (!existing) return orgAccessErrorResponse('NOT_FOUND');

    // The body is parsed only after authorization, so an unauthorized caller
    // learns nothing about the payload contract.
    const body = await parseJsonBody(req, UpdateCampaignBodySchema);
    if (!body.ok) return body.response;

    if (existing.status !== CampaignStatus.DRAFT) {
      return noStoreJson(
        {
          error: 'Only draft campaigns can be edited',
          code: 'CAMPAIGN_NOT_DRAFT',
        },
        409,
      );
    }

    const update = body.data;

    // Defense in depth: the zod enum already restricts the currency, and the
    // settlement layer only supports exactly 2-decimal currencies.
    if (update.currency !== undefined) {
      try {
        assertTwoDecimalCurrency(update.currency);
      } catch (error) {
        if (error instanceof MoneyError) {
          return noStoreJson({ error: 'Unsupported currency' }, 400);
        }
        throw error;
      }
    }

    const data: Prisma.CampaignUpdateManyMutationInput = {
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.description !== undefined
        ? { description: update.description }
        : {}),
      ...(update.totalBudget !== undefined
        ? { totalBudget: update.totalBudget }
        : {}),
      ...(update.currency !== undefined ? { currency: update.currency } : {}),
      ...(update.submissionDeadline !== undefined
        ? { submissionDeadline: update.submissionDeadline }
        : {}),
    };

    // Concurrent edits are last-write-wins on the fields they touch: the CAS
    // below guards the status, not updatedAt. Optimistic concurrency
    // (If-Match / updatedAt) is a deferred follow-up.
    const outcome = await prisma.$transaction(
      async (tx): Promise<UpdateCampaignOutcome> => {
        // Money terms are frozen once any slot exists for this campaign.
        if (
          update.totalBudget !== undefined ||
          update.currency !== undefined
        ) {
          const slotCount = await tx.campaignCreatorSlot.count({
            where: { campaignId: existing.id },
          });
          if (slotCount > 0) return { kind: 'has_slots' };
        }

        const result = await tx.campaign.updateMany({
          where: {
            id: existing.id,
            organizationId: allowed.organizationId,
            status: CampaignStatus.DRAFT,
            deletedAt: null,
          },
          data,
        });
        if (result.count === 0) return { kind: 'conflict' };

        const row = await tx.campaign.findFirst({
          where: {
            id: existing.id,
            organizationId: allowed.organizationId,
            deletedAt: null,
          },
          select: CAMPAIGN_SELECT,
        });
        if (row === null) return { kind: 'conflict' };

        return { kind: 'updated', row };
      },
    );

    if (outcome.kind === 'has_slots') {
      return noStoreJson(
        {
          error: 'Budget and currency cannot change once creators are invited',
          code: 'CAMPAIGN_HAS_SLOTS',
        },
        409,
      );
    }

    if (outcome.kind === 'conflict') {
      return noStoreJson(
        { error: 'Campaign changed. Reload and retry.', code: 'CAMPAIGN_CONFLICT' },
        409,
      );
    }

    // Field NAMES only — never the values, which may include free text.
    console.info('[campaigns] updated', {
      campaignId: outcome.row.id,
      organizationId: outcome.row.organizationId,
      userId: user.userId,
      fields: Object.keys(update),
    });

    return noStoreJson(serializeCampaign(outcome.row));
  } catch (error) {
    console.error('[campaigns] update failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
