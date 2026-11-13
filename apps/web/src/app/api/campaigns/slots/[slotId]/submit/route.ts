// apps/web/src/app/api/campaigns/slots/[slotId]/submit/route.ts
//
// POST /api/campaigns/slots/[slotId]/submit
//
// A creator submits content for a CampaignCreatorSlot they've accepted.
//
// Security: this is a creator writing to a financial record.
//   - platform, contentId, and socialAccountId are always derived server-side —
//     never accepted from the client.
//   - Channel ownership is verified at submit time: the submitted video's
//     snippet.channelId (from the YouTube Data API videos.list endpoint) must
//     match the creator's SocialAccount.externalId. A mismatch, missing video,
//     or any API error is fail-closed: the slot is not updated.
//
// Request order:
//   auth -> provision -> slot id (404) -> creator (404) -> slot lookup scoped
//   to the creator (404) -> status (409) -> campaign active (409) -> deadline
//   (409) -> parse body (400) -> parse URL (400) -> platform gate (422)
//   -> active SocialAccount lookup (409) -> ownership check (409/422/502)
//   -> compare-and-swap updateMany (409 if raced) -> 200

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireAuthApi } from '@/lib/auth/require-auth';
import { provisionedUserOrResponse } from '@/lib/auth/org-access';
import { noStoreJson } from '@/lib/http/json';
import { getCreatorIdForUser } from '@/lib/slots/creator-access';
import { SlotIdParamSchema } from '@/lib/slots/schemas';
import { prisma } from '@repo/database';
import { CampaignStatus, SlotStatus, SocialPlatform } from '@repo/database';
import { parseContentUrl } from '@/lib/campaigns/parse-content-url';
import { isSettlementSupported } from '@/lib/settlement/supported-platforms';
import { getYoutubeAccessToken } from '@/lib/youtube/get-access-token';
import { fetchVideoChannel } from '@/lib/youtube/video-ownership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SubmitBodySchema = z.strictObject({
  contentUrl: z.string().min(1).max(2048),
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

  const user = await provisionedUserOrResponse(authResult.userId);
  if (!user.ok) {
    return user.response;
  }

  const parsedSlotId = SlotIdParamSchema.safeParse((await params).slotId);
  if (!parsedSlotId.success) {
    return noStoreJson({ error: 'Not found' }, 404);
  }
  const slotId = parsedSlotId.data;

  const creatorId = await getCreatorIdForUser(user.userId);
  if (creatorId === null) {
    return noStoreJson({ error: 'Not found' }, 404);
  }

  // Ownership is part of the query: a slot that does not exist, is
  // soft-deleted, belongs to another creator, or is requested by a user with
  // no creator profile all produce the identical 404.
  const slot = await prisma.campaignCreatorSlot.findFirst({
    where: { id: slotId, creatorId, deletedAt: null },
    include: {
      campaign: {
        select: {
          id: true,
          status: true,
          deletedAt: true,
          submissionDeadline: true,
          organization: { select: { deletedAt: true } },
        },
      },
    },
  });

  if (!slot) {
    return noStoreJson({ error: 'Not found' }, 404);
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

  // Campaign state and the submission deadline are invariant preconditions
  // (ADR-0003). They are checked before the body is parsed and before any
  // network call.
  if (
    slot.campaign.deletedAt !== null ||
    slot.campaign.organization.deletedAt !== null ||
    slot.campaign.status !== CampaignStatus.ACTIVE
  ) {
    return noStoreJson(
      { error: 'Campaign is not active', code: 'CAMPAIGN_NOT_ACTIVE' },
      409,
    );
  }

  if (
    slot.campaign.submissionDeadline === null ||
    slot.campaign.submissionDeadline.getTime() <= Date.now()
  ) {
    return noStoreJson(
      {
        error: 'The submission deadline has passed',
        code: 'SUBMISSION_DEADLINE_PASSED',
      },
      409,
    );
  }

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

  // --- STEP 3b: Platform-specific content ownership check -----------------
  //
  // FAIL CLOSED: this switch must handle every platform we support. If a new
  // platform is enabled without adding a verifier here, the default branch
  // returns 500 so the gap is surfaced immediately rather than silently
  // accepting unverified content.
  //
  // This check runs BEFORE the compare-and-swap transaction and OUTSIDE any
  // database transaction, keeping network I/O out of the DB transaction scope.

  switch (platform) {
    case SocialPlatform.YOUTUBE: {
      // Guard: a null ciphertext means the creator never granted offline access
      // (or the token was wiped). We cannot call the API without a token.
      if (socialAccount.tokenCiphertext === null) {
        console.info('[campaigns] slot submit null tokenCiphertext', { slotId });
        return NextResponse.json(
          {
            error: 'YouTube connection needs to be re-authorized',
            code: 'REAUTH_REQUIRED',
          },
          { status: 409 },
        );
      }

      let ownershipResult: Awaited<ReturnType<typeof fetchVideoChannel>>;
      try {
        const accessToken = await getYoutubeAccessToken(
          socialAccount.tokenCiphertext,
        );
        ownershipResult = await fetchVideoChannel(contentId, accessToken);
      } catch (err) {
        // Any error — network, revoked token, malformed response — is fail-closed.
        // We do NOT distinguish invalid_grant here because throwForStatus sets
        // providerCode: 'unknown' for Google's flat { error: string } OAuth
        // envelope (the `error` field is a string, so `error.code` is undefined).
        // Returning 502 keeps the slot untouched and retryable.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[campaigns] slot submit ownership check failed', {
          slotId,
          error: message,
        });
        return NextResponse.json(
          {
            error:
              'Could not verify video ownership with YouTube. Please try again.',
          },
          { status: 502 },
        );
      }

      if (!ownershipResult.found) {
        console.info('[campaigns] slot submit video not found', { slotId });
        return NextResponse.json(
          {
            error: 'Video not found or not accessible',
            code: 'CONTENT_NOT_FOUND',
          },
          { status: 422 },
        );
      }

      if (ownershipResult.channelId !== socialAccount.externalId) {
        // Log slotId only — never log either channel ID.
        console.info(
          '[campaigns] slot submit ownership mismatch for content',
          { slotId },
        );
        return NextResponse.json(
          {
            error:
              'This video does not belong to your connected YouTube channel',
            code: 'CONTENT_OWNERSHIP_MISMATCH',
          },
          { status: 422 },
        );
      }

      // Ownership confirmed — fall through to the compare-and-swap.
      break;
    }

    default: {
      // A platform that passed the isSettlementSupported gate but has no
      // ownership verifier configured here. This is a programming error, not
      // a client error — fail closed so the gap surfaces immediately.
      console.error(
        '[campaigns] slot submit no ownership verifier for platform',
        { slotId, platform },
      );
      return NextResponse.json(
        { error: 'Platform not supported' },
        { status: 500 },
      );
    }
  }

  // --- STEP 4: Write in a single transaction (compare-and-swap) -----------

  const updated = await prisma.$transaction(async (tx) => {
    // Guard the update with where: { id: slotId, status: ACCEPTED } to prevent
    // double-submit race conditions. If zero rows affected, someone else won.
    const result = await tx.campaignCreatorSlot.updateMany({
      where: {
        id: slotId,
        creatorId: slot.creatorId,
        deletedAt: null,
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
