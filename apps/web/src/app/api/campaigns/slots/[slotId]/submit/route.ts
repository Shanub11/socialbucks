// apps/web/src/app/api/campaigns/slots/[slotId]/submit/route.ts
//
// POST /api/campaigns/slots/[slotId]/submit
//
// A creator submits content for a CampaignCreatorSlot they've accepted.
// This is the first real route for Campaign/CampaignCreatorSlot in the codebase.
//
// Security: this is a creator writing to a financial record. Do not trust any
// field in the request body except contentUrl — platform, contentId, and
// socialAccountId are always derived server-side, never accepted from the
// client.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAuthApi } from '@/lib/auth/require-auth';
import { ensureUserProvisioned } from '@/lib/auth/ensure-user';
import { prisma } from '@repo/database';
import { SlotStatus } from '@repo/database';
import { parseContentUrl } from '@/lib/campaigns/parse-content-url';
import { isSettlementSupported } from '@/lib/settlement/supported-platforms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SubmitBodySchema = z.object({
  contentUrl: z.string().min(1),
});

type RouteParams = Promise<{ slotId: string }>;

export async function POST(
  _req: Request,
  { params }: { params: RouteParams },
) {
  // --- STEP 1: Auth & ownership -------------------------------------------

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

  // Load the slot with creator -> user relation for ownership check
  const { slotId } = await params;
  const slot = await prisma.campaignCreatorSlot.findUnique({
    where: { id: slotId },
    include: { creator: { include: { user: true } } },
  });

  if (!slot || slot.deletedAt) {
    return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
  }

  // Authorization: the slot's creator.user.clerkId must equal the authenticated clerk userId.
  // Return 403 (not 404) on ownership mismatch — the creator already knows their
  // own slot IDs from their dashboard, so a clear 403 is better than leaking existence.
  if (slot.creator.user.clerkId !== authResult.userId) {
    console.info('[campaigns] slot submit ownership mismatch', {
      slotId,
      expectedClerkId: slot.creator.user.clerkId,
      actualClerkId: authResult.userId,
    });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Status check: slot must be ACCEPTED. Any other status -> 409 Conflict.
  if (slot.status !== SlotStatus.ACCEPTED) {
    console.info('[campaigns] slot submit wrong status', {
      slotId,
      currentStatus: slot.status,
      expectedStatus: SlotStatus.ACCEPTED,
    });
    return NextResponse.json(
      {
        error: 'Slot not in accepted state',
        currentStatus: slot.status,
        expectedStatus: SlotStatus.ACCEPTED,
      },
      { status: 409 },
    );
  }

  // --- STEP 2: Parse & validate request body -------------------------------

  let body: z.infer<typeof SubmitBodySchema>;
  try {
    const raw = await _req.json();
    body = SubmitBodySchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: error.flatten() },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { contentUrl } = body;

  // --- STEP 2 (cont.): Parse content URL into platform + contentId ---------

  const parsed = parseContentUrl(contentUrl);
  if (!parsed) {
    console.info('[campaigns] slot submit invalid content URL', {
      slotId,
      // Log the URL at info level with slotId for debugging, but treat as
      // unvalidated input — do not echo back in error responses.
    });
    return NextResponse.json(
      { error: 'Unsupported or malformed content URL' },
      { status: 400 },
    );
  }

  const { platform, contentId } = parsed;

  // --- STEP 2b: Fail-closed platform gate ---------------------------------
  // Reject content that can never be approved (and thus never settled).
  // parseContentUrl itself stays unchanged — it is a pure parser and must
  // keep recognising Instagram URLs.

  if (!isSettlementSupported(platform)) {
    console.info('[campaigns] slot submit platform not supported', {
      slotId,
      platform,
    });
    return NextResponse.json(
      {
        error: 'Submission is not yet available for this platform',
        code: 'PLATFORM_NOT_SUPPORTED',
        platform,
      },
      { status: 422 },
    );
  }

  // --- STEP 3: Find the creator's active SocialAccount for that platform ---

  const socialAccount = await prisma.socialAccount.findFirst({
    where: {
      creatorId: slot.creatorId,
      platform,
      revokedAt: null,
    },
  });

  if (!socialAccount) {
    console.info('[campaigns] slot submit no social account', {
      slotId,
      creatorId: slot.creatorId,
      platform,
    });
    return NextResponse.json(
      {
        error: 'No active social account for platform',
        platform,
        message: `Connect your ${platform.toLowerCase()} account first`,
      },
      { status: 409 },
    );
  }

  // --- STEP 4: Write in a single transaction (compare-and-swap) -----------

  const updated = await prisma.$transaction(async (tx) => {
    // Guard the update with where: { id: slotId, status: ACCEPTED } to prevent
    // double-submit race conditions. If zero rows affected, someone else won.
    const result = await tx.campaignCreatorSlot.updateMany({
      where: {
        id: slotId,
        status: SlotStatus.ACCEPTED,
      },
      data: {
        contentUrl,
        platform,
        contentId,
        socialAccountId: socialAccount.id,
        submittedAt: new Date(),
        status: SlotStatus.CONTENT_SUBMITTED,
      },
    });

    if (result.count === 0) {
      return null; // Race: another request already moved the slot out of ACCEPTED
    }

    // Fetch the updated slot for the response (without heavy includes)
    return tx.campaignCreatorSlot.findUnique({
      where: { id: slotId },
      select: {
        id: true,
        status: true,
        platform: true,
        contentId: true,
        submittedAt: true,
      },
    });
  });

  if (!updated) {
    // Another request won the race — return 409 so the caller can re-fetch
    // and see the current state.
    return NextResponse.json(
      { error: 'Slot already submitted', currentStatus: SlotStatus.CONTENT_SUBMITTED },
      { status: 409 },
    );
  }

  // --- STEP 5: Response ----------------------------------------------------

  return NextResponse.json({
    id: updated.id,
    status: updated.status,
    platform: updated.platform,
    contentId: updated.contentId,
    submittedAt: updated.submittedAt,
  });
}