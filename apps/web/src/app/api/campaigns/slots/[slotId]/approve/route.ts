// apps/web/src/app/api/campaigns/slots/[slotId]/approve/route.ts
//
// POST /api/campaigns/slots/[slotId]/approve
//
// A brand/org member approves submitted content, setting the view target
// and (for YouTube) verifying the Shorts classification before the slot
// becomes eligible for settleSlot().
//
// Security: this is a financial approval path. Only OWNER or ADMIN members
// can approve - MEMBERS must not be able to escalate privileges.
//
// Request order: auth -> provision -> slot id (404) -> slot load (404) ->
// org access/role (404/403) -> self-approval guard (403) -> campaign active
// (409) -> slot status (409) -> body (400) -> view target (409) -> platform
// gate (422/500) -> YouTube verification (409/422/502) -> compare-and-swap
// (409) -> 200.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAuthApi } from '@/lib/auth/require-auth';
import {
  ORG_MANAGER_ROLES,
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
  requireOrgRole,
} from '@/lib/auth/org-access';
import { noStoreJson } from '@/lib/http/json';
import { SlotIdParamSchema } from '@/lib/slots/schemas';
import { prisma } from '@repo/database';
import { CampaignStatus, SlotStatus, SocialPlatform } from '@repo/database';
import { getYoutubeAccessToken } from '@/lib/youtube/get-access-token';
import { verifyIsShort } from '@/lib/youtube/analytics';
import { isSettlementSupported } from '@/lib/settlement/supported-platforms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Body must be empty or {}. viewTarget is now read from the slot (ADR-0003 D2).
// Unknown keys are rejected to fail-closed on malformed requests.
const ApproveBodySchema = z.object({}).strict();

type RouteParams = Promise<{ slotId: string }>;

export async function POST(
  _req: Request,
  { params }: { params: RouteParams },
) {
  // --- STEP 1: Auth & load -------------------------------------------------

  const authResult = await requireAuthApi();
  if (!authResult.ok) {
    return authResult.response;
  }

  const user = await provisionedUserOrResponse(authResult.userId);
  if (!user.ok) {
    return user.response;
  }

  const parsedSlotId = SlotIdParamSchema.safeParse((await params).slotId);
  if (!parsedSlotId.success) {
    return noStoreJson({ error: 'Not found' }, 404);
  }
  const slotId = parsedSlotId.data;

  // Load the slot with its campaign (org id + campaign state) and the
  // socialAccount (for the YouTube token).
  const slot = await prisma.campaignCreatorSlot.findUnique({
    where: { id: slotId },
    include: {
      campaign: {
        select: { organizationId: true, status: true, deletedAt: true },
      },
      creator: { select: { userId: true } },
      socialAccount: true,
    },
  });

  if (!slot || slot.deletedAt) {
    return noStoreJson({ error: 'Not found' }, 404);
  }

  // --- STEP 2: Authorization - org OWNER or ADMIN only ---------------------

  // A non-member, a member of a soft-deleted org and an unknown slot all get
  // the same 404; a MEMBER-role caller gets 403.
  const access = await getOrgAccess(user.userId, slot.campaign.organizationId);
  if (!access.ok) {
    return orgAccessErrorResponse(access.reason);
  }

  const allowed = requireOrgRole(access, ORG_MANAGER_ROLES);
  if (!allowed.ok) {
    return orgAccessErrorResponse(allowed.reason);
  }

  // --- STEP 2b: Self-approval guard ------------------------------------------
  // A creator who is also an OWNER/ADMIN of the campaign's organization must
  // not approve their own submitted content. This runs *after* the membership
  // check (so non-members never see the SELF_APPROVAL_NOT_ALLOWED reason —
  // no information leak on slot ownership) and *before* the status check and
  // any token decryption, YouTube API call, or DB write, so a blocked request
  // touches nothing external.
  // NOTE: this is not a complete fraud-control surface — it does not catch
  // colluding admins and creators in the same org. See ADR-0002.
  if (slot.creator.userId === user.userId) {
    console.warn('[campaigns] slot approve self-approval blocked', {
      slotId,
      organizationId: slot.campaign.organizationId,
    });
    return NextResponse.json(
      {
        error: 'You cannot approve your own content',
        code: 'SELF_APPROVAL_NOT_ALLOWED',
      },
      { status: 403 },
    );
  }

  // --- STEP 3: Status check ------------------------------------------------

  // Campaign state is an invariant of the transition (ADR-0003 invariant 5)
  // and must be checked before the status check and before any token
  // decryption or network call.
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
    console.info('[campaigns] slot approve wrong status', {
      slotId,
      currentStatus: slot.status,
    });
    return NextResponse.json(
      {
        error: 'Slot not in submitted state',
        currentStatus: slot.status,
        expectedStatus: SlotStatus.CONTENT_SUBMITTED,
      },
      { status: 409 },
    );
  }

  // --- STEP 0: Parse and validate request body -----------------------------
  // Per ADR-0003 D2: viewTarget is read from the slot, not the body. Strict()
  // rejects unknown keys (including `viewTarget`), so {} and an empty body are
  // accepted; any other shape returns 400. Not stored — later checks read the
  // slot row instead.
  try {
    let raw: unknown = {};
    const text = await _req.text();
    if (!text || text.trim().length === 0) {
      // Empty or whitespace-only body -> treat as {} (approve call with no body still works).
      raw = {};
    } else {
      // Non-empty text -> parse JSON; if throws, reject with 400.
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
      }
      raw = parsed;
    }
    ApproveBodySchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: error.flatten() },
        { status: 400 },
      );
    }
    // Unexpected non-Zod error from schema validation - should not happen.
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  // --- viewTarget from slot, not body (ADR-0003 D2) --------------------
  // The viewTarget must have been set at invite time; if it is null or <= 0,
  // the slot cannot settle — respond 409 with opaque error code.
  if (slot.viewTarget == null || slot.viewTarget <= 0) {
    return NextResponse.json(
      { error: 'Slot terms are missing or invalid', code: 'SLOT_TERMS_MISSING' },
      { status: 409 },
    );
  }

  // --- STEP 4: Fail-closed platform gate ----------------------------------
  // Runs before any token decryption or network call.

  if (slot.platform === null) {
    // A CONTENT_SUBMITTED slot must have a platform (set at submit time).
    // This is an invariant violation, not a client error.
    console.error(
      '[campaigns] slot approve platform null for CONTENT_SUBMITTED slot',
      { slotId },
    );
    return NextResponse.json(
      { error: 'Slot data is inconsistent' },
      { status: 500 },
    );
  }

  if (!isSettlementSupported(slot.platform)) {
    console.info('[campaigns] slot approve platform not supported', {
      slotId,
      platform: slot.platform,
    });
    return NextResponse.json(
      {
        error: 'Approval is not yet available for this platform',
        code: 'PLATFORM_NOT_SUPPORTED',
        platform: slot.platform,
      },
      { status: 422 },
    );
  }

  // --- STEP 4b: Platform-specific verification ------------------------------

  let isShortValue: boolean | undefined;
  let isShortVerifiedAtValue: Date | undefined;

  if (slot.platform === SocialPlatform.YOUTUBE) {
    // YouTube requires a valid socialAccount with non-revoked token
    if (!slot.socialAccount) {
      console.info('[campaigns] slot approve no social account for YouTube', {
        slotId,
      });
      return NextResponse.json(
        { error: 'Social account not found for YouTube content' },
        { status: 409 },
      );
    }

    if (slot.socialAccount.revokedAt) {
      console.info('[campaigns] slot approve social account revoked for YouTube', {
        slotId,
        socialAccountId: slot.socialAccount.id,
      });
      return NextResponse.json(
        { error: 'Social account has been revoked. Please reconnect.' },
        { status: 409 },
      );
    }

    if (!slot.socialAccount.tokenCiphertext) {
      console.info('[campaigns] slot approve no token ciphertext for YouTube', {
        slotId,
        socialAccountId: slot.socialAccount.id,
      });
      return NextResponse.json(
        { error: 'Social account token not available. Please reconnect.' },
        { status: 409 },
      );
    }

    // YouTube: verify isShort via Analytics API
    // Note: slot.contentId is guaranteed non-null because slot.status
    // is CONTENT_SUBMITTED (which requires contentId to be set at submit time)
    if (!slot.contentId) {
      console.error('[campaigns] slot approve contentId is null for CONTENT_SUBMITTED slot', {
        slotId,
      });
      return NextResponse.json(
        { error: 'Content ID missing. This should never happen.' },
        { status: 500 },
      );
    }

    try {
      const accessToken = await getYoutubeAccessToken(slot.socialAccount.tokenCiphertext);
      const isShort = await verifyIsShort(slot.contentId, accessToken);

      if (!isShort) {
        console.info('[campaigns] slot approve verifyIsShort returned false', {
          slotId,
          contentId: slot.contentId,
        });
        return NextResponse.json(
          { error: 'Content is not classified as a Short by YouTube', reason: 'creatorContentType dimension returned non-SHORTS' },
          { status: 422 },
        );
      }

      isShortValue = true;
      isShortVerifiedAtValue = new Date();
    } catch (error) {
      console.error('[campaigns] slot approve verifyIsShort failed', {
        slotId,
        contentId: slot.contentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'Could not verify content right now. Please try again later.' },
        { status: 502 },
      );
    }
  }

  // Only supported platforms reach here (currently YouTube only).
  // Instagram and any future unsupported platform were rejected by the
  // fail-closed gate above. For platforms without a verification step,
  // isShort stays null.

  // --- STEP 5: Write with compare-and-swap ---------------------------------

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.campaignCreatorSlot.updateMany({
      where: {
        id: slotId,
        deletedAt: null,
        status: SlotStatus.CONTENT_SUBMITTED,
      },
      data: {
        // viewTarget is read-only from the slot (ADR-0003 D2); it was set at
        // invite and cannot be changed after acceptance.
        approvedAt: new Date(),
        status: SlotStatus.IN_PROGRESS,
        // For YouTube: set isShort and isShortVerifiedAt
        // For Instagram: leave these null (they stay undefined in Prisma)
        ...(isShortValue !== undefined
          ? { isShort: isShortValue, isShortVerifiedAt: isShortVerifiedAtValue }
          : {}),
      },
    });

    if (result.count === 0) {
      return null; // Race: another request already changed the slot
    }

    return tx.campaignCreatorSlot.findUnique({
      where: { id: slotId },
      select: {
        id: true,
        status: true,
        viewTarget: true,
        approvedAt: true,
        isShort: true,
        isShortVerifiedAt: true,
      },
    });
  });

  if (!updated) {
    return NextResponse.json(
      { error: 'Slot approval failed. Another request may have already approved it.' },
      { status: 409 },
    );
  }

  // --- STEP 6: Response ----------------------------------------------------

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    viewTarget: updated.viewTarget,
    approvedAt: updated.approvedAt,
    ...(updated.isShort !== undefined ? { isShort: updated.isShort } : {}),
    ...(updated.isShortVerifiedAt ? { isShortVerifiedAt: updated.isShortVerifiedAt } : {}),
  });
}
