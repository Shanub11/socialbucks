// apps/web/src/app/api/orgs/[orgId]/campaigns/route.ts
//
// POST /api/orgs/[orgId]/campaigns — create a DRAFT campaign (OWNER/ADMIN).
// GET  /api/orgs/[orgId]/campaigns — list the organization's live campaigns
//                                    (any member, cursor paginated).
//
// Authorization is resolved before the request body is read, and the org id
// used in every query comes from the verified access result, never from the
// URL directly.

import { CampaignStatus, prisma } from '@repo/database';

import {
  ORG_MANAGER_ROLES,
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
  requireOrgRole,
} from '@/lib/auth/org-access';
import { requireAuthApi } from '@/lib/auth/require-auth';
import {
  MAX_DRAFT_CAMPAIGNS_PER_ORG,
} from '@/lib/campaigns/constants';
import {
  CAMPAIGN_SELECT,
  type CampaignRow,
  serializeCampaign,
} from '@/lib/campaigns/serialize';
import {
  CreateCampaignBodySchema,
  ListCampaignsQuerySchema,
} from '@/lib/campaigns/schemas';
import { noStoreJson, parseJsonBody, parseQuery } from '@/lib/http/json';
import { DEFAULT_PAGE_SIZE } from '@/lib/orgs/constants';
import { OrgIdParamSchema } from '@/lib/orgs/schemas';
import { MoneyError, assertTwoDecimalCurrency } from '@/lib/settlement/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CreateCampaignOutcome =
  | { kind: 'limit' }
  | { kind: 'created'; row: CampaignRow };

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const authResult = await requireAuthApi();
    if (!authResult.ok) return authResult.response;

    const user = await provisionedUserOrResponse(authResult.userId);
    if (!user.ok) return user.response;

    // This version of Next.js passes route params as a Promise.
    const { orgId } = await params;

    const parsedOrgId = OrgIdParamSchema.safeParse(orgId);
    if (!parsedOrgId.success) return orgAccessErrorResponse('NOT_FOUND');

    const access = await getOrgAccess(user.userId, parsedOrgId.data);
    if (!access.ok) return orgAccessErrorResponse(access.reason);

    const allowed = requireOrgRole(access, ORG_MANAGER_ROLES);
    if (!allowed.ok) return orgAccessErrorResponse(allowed.reason);

    // The body is parsed only after authorization, so an unauthorized caller
    // learns nothing about the payload contract and cannot create anything.
    const body = await parseJsonBody(req, CreateCampaignBodySchema);
    if (!body.ok) return body.response;

    // Defense in depth: the zod enum already restricts the currency, and the
    // settlement layer only supports exactly 2-decimal currencies.
    try {
      assertTwoDecimalCurrency(body.data.currency);
    } catch (error) {
      if (error instanceof MoneyError) {
        return noStoreJson({ error: 'Unsupported currency' }, 400);
      }
      throw error;
    }

    const outcome = await prisma.$transaction(
      async (tx): Promise<CreateCampaignOutcome> => {
        const draftCount = await tx.campaign.count({
          where: {
            organizationId: allowed.organizationId,
            status: CampaignStatus.DRAFT,
            deletedAt: null,
          },
        });

        // Soft abuse guard, deliberately NOT race-safe: two concurrent requests
        // can both read draftCount = MAX - 1 and both create. Real rate limiting
        // belongs at the edge; this only stops trivial scripted abuse.
        if (draftCount >= MAX_DRAFT_CAMPAIGNS_PER_ORG) {
          return { kind: 'limit' };
        }

        const row = await tx.campaign.create({
          data: {
            organizationId: allowed.organizationId,
            title: body.data.title,
            description: body.data.description ?? null,
            totalBudget: body.data.totalBudget,
            currency: body.data.currency,
            submissionDeadline: body.data.submissionDeadline ?? null,
            status: CampaignStatus.DRAFT,
          },
          select: CAMPAIGN_SELECT,
        });

        return { kind: 'created', row };
      },
    );

    if (outcome.kind === 'limit') {
      return noStoreJson(
        {
          error: 'Draft campaign limit reached',
          code: 'CAMPAIGN_LIMIT_REACHED',
        },
        409,
      );
    }

    console.info('[campaigns] created', {
      campaignId: outcome.row.id,
      organizationId: outcome.row.organizationId,
      userId: user.userId,
    });

    return noStoreJson(serializeCampaign(outcome.row), 201);
  } catch (error) {
    console.error('[campaigns] create campaign failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const authResult = await requireAuthApi();
    if (!authResult.ok) return authResult.response;

    const user = await provisionedUserOrResponse(authResult.userId);
    if (!user.ok) return user.response;

    // This version of Next.js passes route params as a Promise.
    const { orgId } = await params;

    const parsedOrgId = OrgIdParamSchema.safeParse(orgId);
    if (!parsedOrgId.success) return orgAccessErrorResponse('NOT_FOUND');

    // Any member (including MEMBER) may read the organization's campaigns.
    const access = await getOrgAccess(user.userId, parsedOrgId.data);
    if (!access.ok) return orgAccessErrorResponse(access.reason);

    const query = parseQuery(req, ListCampaignsQuerySchema);
    if (!query.ok) return query.response;

    const limit = query.data.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.data.cursor;
    const status = query.data.status;

    if (cursor !== undefined) {
      // The cursor must be a live campaign of THIS organization. A cursor from
      // another org (or a soft-deleted one) is rejected rather than used to
      // position the page, so it cannot be probed or cross a tenant boundary.
      const cursorRow = await prisma.campaign.findFirst({
        where: {
          id: cursor,
          organizationId: access.organizationId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!cursorRow) {
        return noStoreJson({ error: 'Invalid cursor' }, 400);
      }
    }

    const rows = await prisma.campaign.findMany({
      where: {
        organizationId: access.organizationId,
        deletedAt: null,
        ...(status !== undefined ? { status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: CAMPAIGN_SELECT,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last !== undefined ? last.id : null;

    return noStoreJson({
      items: page.map((row) => serializeCampaign(row)),
      nextCursor,
    });
  } catch (error) {
    console.error('[campaigns] list campaigns failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
