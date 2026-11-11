// apps/web/src/app/api/orgs/[orgId]/campaigns/[campaignId]/invites/route.ts
//
// POST /api/orgs/[orgId]/campaigns/[campaignId]/invites — invite one creator to
// an ACTIVE campaign (OWNER/ADMIN only).
//
// The organization comes from the verified access result, never from the URL
// alone: the campaign is loaded and locked with organizationId + deletedAt: null
// inside createInvite. The body is parsed only after authorization.
//
// No oracle (ADR-0003 D7): every "this address cannot be invited" cause maps to
// the SAME 422 body. Only a successful 201 says anything about the address.

import {
  ORG_MANAGER_ROLES,
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
  requireOrgRole,
} from '@/lib/auth/org-access';
import { requireAuthApi } from '@/lib/auth/require-auth';
import { CampaignIdParamSchema } from '@/lib/campaigns/schemas';
import { noStoreJson, parseJsonBody } from '@/lib/http/json';
import { createInvite, type CreateInviteOutcome } from '@/lib/invites/create-invite';
import { CreateInviteBodySchema } from '@/lib/invites/schemas';
import { serializeInvite } from '@/lib/invites/serialize';
import { OrgIdParamSchema } from '@/lib/orgs/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
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

    // Parsed only after the caller is authorized to write to this organization.
    const body = await parseJsonBody(req, CreateInviteBodySchema);
    if (!body.ok) return body.response;

    const outcome: CreateInviteOutcome = await createInvite({
      organizationId: allowed.organizationId,
      campaignId: parsedCampaignId.data,
      creatorEmail: body.data.creatorEmail,
      escrowAmount: body.data.escrowAmount,
      viewTarget: body.data.viewTarget,
    });

    // Exhaustive: a new outcome kind fails to compile until it is handled here.
    switch (outcome.kind) {
      case 'campaign_not_found':
        return orgAccessErrorResponse('NOT_FOUND');
      case 'campaign_not_active':
        return noStoreJson(
          { error: 'Campaign is not active', code: 'CAMPAIGN_NOT_ACTIVE' },
          409,
        );
      case 'deadline_passed':
        return noStoreJson(
          {
            error: 'The submission deadline has passed',
            code: 'SUBMISSION_DEADLINE_PASSED',
          },
          409,
        );
      case 'slot_limit':
        return noStoreJson(
          {
            error: 'Invite limit reached for this campaign',
            code: 'SLOT_LIMIT_REACHED',
          },
          409,
        );
      case 'budget_exceeded':
        return noStoreJson(
          {
            error: 'Escrow exceeds the remaining campaign budget',
            code: 'BUDGET_EXCEEDED',
            remainingBudget: outcome.remaining,
          },
          409,
        );
      case 'not_eligible':
        // Identical for EVERY ineligible cause: no oracle.
        return noStoreJson(
          {
            error: 'Creator not found or not eligible',
            code: 'CREATOR_NOT_ELIGIBLE',
          },
          422,
        );
      case 'created':
        console.info('[invites] created', {
          slotId: outcome.invite.id,
          campaignId: outcome.invite.campaignId,
          organizationId: allowed.organizationId,
          inviterUserId: user.userId,
        });
        return noStoreJson(serializeInvite(outcome.invite), 201);
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unhandled invite outcome: ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    console.error('[invites] create failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
