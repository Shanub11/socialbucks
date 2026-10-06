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

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAuthApi } from '@/lib/auth/require-auth';
import { ensureUserProvisioned } from '@/lib/auth/ensure-user';
import { prisma } from '@repo/database';
import { SlotStatus, SocialPlatform } from '@repo/database';
import { getYoutubeAccessToken } from '@/lib/youtube/get-access-token';
import { verifyIsShort } from '@/lib/youtube/analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// viewTarget must be a positive integer
const ApproveBodySchema = z.object({
  viewTarget: z.number().int().positive(),
});

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

  const provisioned = await ensureUserProvisioned(authResult.userId);
  if (!provisioned.ok) {
    return NextResponse.json(
      { error: 'User not provisioned', reason: provisioned.reason },
      { status: 500 },
    );
  }

  const { slotId } = await params;

  // Load slot with campaign (for orgId) and socialAccount (for token)
  const slot = await prisma.campaignCreatorSlot.findUnique({
    where: { id: slotId },
    include: {
      campaign: { select: { organizationId: true } },
      socialAccount: true,
    },
  });

  if (!slot || slot.deletedAt) {
    return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
  }

  // --- STEP 2: Authorization - org OWNER or ADMIN only ---------------------

  const membership = await prisma.organizationMember.findFirst({
    where: {
      organizationId: slot.campaign.organizationId,
      userId: provisioned.userId,
      role: { in: ['OWNER', 'ADMIN'] },
    },
  });

  if (!membership) {
    console.info('[campaigns] slot approve insufficient permissions', {
      slotId,
      clerkUserId: authResult.userId,
      organizationId: slot.campaign.organizationId,
    });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // --- STEP 3: Status check ------------------------------------------------

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

  let body: z.infer<typeof ApproveBodySchema>;
  try {
    const raw = await _req.json();
    body = ApproveBodySchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: error.flatten() },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // --- STEP 4: Platform-specific verification ------------------------------

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

  // Instagram: skip verification entirely. isShort stays null (correct per schema).

  // --- STEP 5: Write with compare-and-swap ---------------------------------

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.campaignCreatorSlot.updateMany({
      where: {
        id: slotId,
        status: SlotStatus.CONTENT_SUBMITTED,
      },
      data: {
        viewTarget: body.viewTarget,
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
