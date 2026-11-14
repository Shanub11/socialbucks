// apps/web/src/app/api/campaigns/slots/[slotId]/cancel/route.test.ts
//
// Real-database integration tests for POST /api/campaigns/slots/[slotId]/cancel
// (ADR-0003 state machine: INVITED or ACCEPTED -> CANCELLED).
//
// REQUIRES RUN_DB_TESTS=1 and a reachable Postgres at TEST_DATABASE_URL.
// If the DB is unreachable, the suite FAILS LOUDLY — it never silently skips.
//
// Only Clerk auth is mocked for the route itself. The two YouTube helpers are
// mocked as well, solely so that accept/submit can be driven in the
// cancellation race tests. Prisma is real and nothing about the database is
// faked.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignStatus,
  Prisma,
  PrismaClient,
  SlotStatus,
  SocialPlatform,
} from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';

// Auth identity is chosen per request: `pending` is consumed synchronously by
// the handler's first `await auth()`, so two requests started in one
// Promise.all keep their own identity even though the mock is shared.
const authState = vi.hoisted(() => ({
  defaultUserId: null as string | null,
  pending: [] as (string | null)[],
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({
    userId:
      authState.pending.length > 0
        ? authState.pending.shift()!
        : authState.defaultUserId,
    sessionClaims: null,
  })),
}));

vi.mock('@/lib/youtube/get-access-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/get-access-token')>();
  return { ...actual, getYoutubeAccessToken: vi.fn() };
});

vi.mock('@/lib/youtube/video-ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/video-ownership')>();
  return { ...actual, fetchVideoChannel: vi.fn() };
});

import { getYoutubeAccessToken } from '@/lib/youtube/get-access-token';
import { fetchVideoChannel } from '@/lib/youtube/video-ownership';
import { POST as cancelSlot } from './route';
import { POST as acceptSlot } from '../accept/route';
import { POST as submitSlot } from '../submit/route';
import { resetTestDatabase } from '@/test/reset-test-db';
import { createInvite } from '@/lib/invites/create-invite';

const DAY_MS = 24 * 60 * 60 * 1000;

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn('RUN_DB_TESTS != 1 — cancel route tests are SKIPPED, not passing.');
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDb('POST /api/campaigns/slots/[slotId]/cancel', () => {
  if (process.env.RUN_DB_TESTS === '1' && !process.env.TEST_DATABASE_URL) {
    throw new Error('RUN_DB_TESTS=1 but TEST_DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    authState.defaultUserId = null;
    authState.pending.length = 0;
    vi.mocked(getYoutubeAccessToken).mockResolvedValue('fake-access-token-123');
    vi.mocked(fetchVideoChannel).mockResolvedValue({
      found: true,
      channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
    });
    await resetTestDatabase(prisma);
  });

  // -------------------------------------------------------------------------
  // seedScenario
  // -------------------------------------------------------------------------

  interface SeedOptions {
    callerRole?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'NONE';
    /** The brand caller is also the slot's creator (self-action scenario). */
    callerIsCreator?: boolean;
    orgDeleted?: boolean;
    campaignStatus?: CampaignStatus;
    campaignDeleted?: boolean;
    totalBudget?: string;
    slotStatus?: SlotStatus;
    slotDeleted?: boolean;
    escrowAmount?: string;
    inviteExpiresAt?: Date | null;
    cancelledAt?: Date | null;
    rejectedAt?: Date | null;
    rejectionReason?: string | null;
  }

  interface SeedResult {
    callerClerkId: string;
    creatorClerkId: string;
    slotId: string;
    organizationId: string;
    campaignId: string;
    creatorId: string;
    externalId: string;
  }

  async function seedScenario(options: SeedOptions = {}): Promise<SeedResult> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const callerRole = options.callerRole ?? 'OWNER';

    const org = await prisma.organization.create({
      data: {
        name: `Cancel Org ${suffix}`,
        deletedAt: options.orgDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    const callerUser = await prisma.user.create({
      data: {
        clerkId: `clerk_cancel_caller_${suffix}`,
        email: `caller_${suffix}@test.local`,
      },
      select: { id: true, clerkId: true },
    });

    if (callerRole !== 'NONE') {
      await prisma.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: callerUser.id,
          role: callerRole,
        },
      });
    }

    // A slot's creator, unless the caller is the creator too.
    const creatorUser = options.callerIsCreator
      ? callerUser
      : await prisma.user.create({
          data: {
            clerkId: `clerk_cancel_creator_${suffix}`,
            email: `creator_${suffix}@test.local`,
          },
          select: { id: true, clerkId: true },
        });

    const creator = await prisma.creator.create({
      data: { userId: creatorUser.id },
      select: { id: true },
    });

    const externalId = `ext_${suffix}`;
    await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId,
        handle: `handle_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake.${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Cancel Campaign ${suffix}`,
        totalBudget: new Prisma.Decimal(options.totalBudget ?? '1000.00'),
        currency: 'USD',
        status: options.campaignStatus ?? CampaignStatus.ACTIVE,
        submissionDeadline: new Date(Date.now() + 30 * DAY_MS),
        deletedAt: options.campaignDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        escrowAmount: new Prisma.Decimal(options.escrowAmount ?? '1000.00'),
        status: options.slotStatus ?? SlotStatus.INVITED,
        viewTarget: 1000,
        metric: 'engagedViews',
        invitedAt: new Date(),
        inviteExpiresAt:
          options.inviteExpiresAt === undefined
            ? new Date(Date.now() + 7 * DAY_MS)
            : options.inviteExpiresAt,
        deletedAt: options.slotDeleted ? new Date() : null,
        cancelledAt: options.cancelledAt ?? null,
        rejectedAt: options.rejectedAt ?? null,
        rejectionReason: options.rejectionReason ?? null,
      },
      select: { id: true },
    });

    return {
      callerClerkId: callerUser.clerkId,
      creatorClerkId: creatorUser.clerkId,
      slotId: slot.id,
      organizationId: org.id,
      campaignId: campaign.id,
      creatorId: creator.id,
      externalId,
    };
  }

  /** A second, invitable creator: YouTube connected, not an org member. */
  async function seedEligibleCreator(): Promise<{ email: string }> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const user = await prisma.user.create({
      data: {
        clerkId: `clerk_cancel_eligible_${suffix}`,
        email: `eligible_${suffix}@test.local`,
      },
      select: { id: true, email: true },
    });
    const creator = await prisma.creator.create({
      data: { userId: user.id },
      select: { id: true },
    });
    await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId: `ext_eligible_${suffix}`,
        handle: `eligible_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake_eligible_${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });
    return { email: user.email };
  }

  // -------------------------------------------------------------------------
  // Request helpers
  // -------------------------------------------------------------------------

  function cancelRequest(
    slotId: string,
    init: { body?: string },
  ): Promise<Response> {
    const requestInit: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    };
    if (init.body !== undefined) requestInit.body = init.body;
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/cancel`,
      requestInit,
    );
    return cancelSlot(req, { params: Promise.resolve({ slotId }) });
  }

  function callCancel(
    slotId: string,
    options: { as?: string | null; rawBody?: string } = {},
  ): Promise<Response> {
    // The push and the POST call happen in one synchronous block, so the
    // handler consumes exactly this identity.
    authState.pending.push(
      options.as === undefined ? authState.defaultUserId : options.as,
    );
    return cancelRequest(slotId, { body: options.rawBody });
  }

  function callAccept(slotId: string, as: string): Promise<Response> {
    authState.pending.push(as);
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/accept`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    );
    return acceptSlot(req, { params: Promise.resolve({ slotId }) });
  }

  function callSubmit(
    slotId: string,
    as: string,
    channelId: string,
  ): Promise<Response> {
    vi.mocked(fetchVideoChannel).mockResolvedValue({ found: true, channelId });
    authState.pending.push(as);
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contentUrl: 'https://www.youtube.com/shorts/vidCancelX1',
        }),
      },
    );
    return submitSlot(req, { params: Promise.resolve({ slotId }) });
  }

  async function snapshotSlot(slotId: string) {
    return prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: {
        status: true,
        cancelledAt: true,
        approvedAt: true,
        settlementEndsAt: true,
        currentTier: true,
        paidToDate: true,
        contentId: true,
        platform: true,
        rejectedAt: true,
        rejectionReason: true,
      },
    });
  }

  // =======================================================================
  // 1. INVITED -> CANCELLED
  // =======================================================================

  it('cancels an INVITED slot and returns id, status and the stored cancelledAt', async () => {
    const f = await seedScenario({ slotStatus: SlotStatus.INVITED });
    authState.defaultUserId = f.callerClerkId;

    const res = await callCancel(f.slotId);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as {
      id: string;
      status: SlotStatus;
      cancelledAt: string;
    };
    const slot = await snapshotSlot(f.slotId);

    expect(slot.status).toBe(SlotStatus.CANCELLED);
    expect(slot.cancelledAt).not.toBeNull();
    expect(body).toEqual({
      id: f.slotId,
      status: SlotStatus.CANCELLED,
      cancelledAt: slot.cancelledAt!.toISOString(),
    });
  });

  // =======================================================================
  // 2. ACCEPTED -> CANCELLED, including a previously rejected submission
  // =======================================================================

  it('cancels an ACCEPTED slot and returns the stored cancelledAt', async () => {
    const f = await seedScenario({ slotStatus: SlotStatus.ACCEPTED });
    authState.defaultUserId = f.callerClerkId;

    const res = await callCancel(f.slotId);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: string;
      status: SlotStatus;
      cancelledAt: string;
    };
    const slot = await snapshotSlot(f.slotId);

    expect(slot.status).toBe(SlotStatus.CANCELLED);
    expect(body).toEqual({
      id: f.slotId,
      status: SlotStatus.CANCELLED,
      cancelledAt: slot.cancelledAt!.toISOString(),
    });
  });

  it('cancels an ACCEPTED slot that was previously rejected, leaving the rejection record intact', async () => {
    const rejectedAt = new Date('2026-02-03T04:05:06.000Z');
    const f = await seedScenario({
      slotStatus: SlotStatus.ACCEPTED,
      rejectedAt,
      rejectionReason: 'The hook is unclear in the first seconds',
    });
    authState.defaultUserId = f.callerClerkId;

    const res = await callCancel(f.slotId);
    expect(res.status).toBe(200);

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.CANCELLED);
    expect(slot.cancelledAt).not.toBeNull();
    expect(slot.rejectedAt).toEqual(rejectedAt);
    expect(slot.rejectionReason).toBe('The hook is unclear in the first seconds');
  });

  // =======================================================================
  // 3. No money moves
  // =======================================================================

  it('writes no PayoutEvent and leaves the settlement fields untouched', async () => {
    const f = await seedScenario({ slotStatus: SlotStatus.ACCEPTED });
    authState.defaultUserId = f.callerClerkId;

    const before = await snapshotSlot(f.slotId);
    expect((await callCancel(f.slotId)).status).toBe(200);
    const after = await snapshotSlot(f.slotId);

    expect(after.status).toBe(SlotStatus.CANCELLED);
    expect(after.approvedAt).toEqual(before.approvedAt);
    expect(after.settlementEndsAt).toEqual(before.settlementEndsAt);
    expect(after.currentTier).toBe(before.currentTier);
    expect(after.paidToDate.toFixed(2)).toBe(before.paidToDate.toFixed(2));
    expect(after.paidToDate.toFixed(2)).toBe('0.00');

    const events = await prisma.payoutEvent.findMany({
      where: { slotId: f.slotId },
    });
    expect(events).toHaveLength(0);
  });

  // =======================================================================
  // 4. Cancelling frees committed escrow
  // =======================================================================

  it('frees the cancelled slot budget so the campaign can invite again', async () => {
    const f = await seedScenario({
      totalBudget: '1000.00',
      escrowAmount: '1000.00',
      slotStatus: SlotStatus.INVITED,
    });
    const other = await seedEligibleCreator();

    // The whole budget is committed by the first slot.
    const first = await createInvite({
      organizationId: f.organizationId,
      campaignId: f.campaignId,
      creatorEmail: other.email,
      escrowAmount: new Prisma.Decimal('500.00'),
      viewTarget: 1000,
    });
    expect(first.kind).toBe('budget_exceeded');

    authState.defaultUserId = f.callerClerkId;
    expect((await callCancel(f.slotId)).status).toBe(200);

    // CANCELLED is a freed-escrow status, so the same invite now fits.
    const second = await createInvite({
      organizationId: f.organizationId,
      campaignId: f.campaignId,
      creatorEmail: other.email,
      escrowAmount: new Prisma.Decimal('500.00'),
      viewTarget: 1000,
    });
    expect(second.kind).toBe('created');
  });

  // =======================================================================
  // 5. Non-cancellable statuses
  // =======================================================================

  const NON_CANCELLABLE_STATUSES: SlotStatus[] = [
    SlotStatus.CONTENT_SUBMITTED,
    SlotStatus.IN_PROGRESS,
    SlotStatus.COMPLETED,
    SlotStatus.DISPUTED,
    SlotStatus.DECLINED,
    SlotStatus.EXPIRED,
    SlotStatus.CANCELLED,
  ];

  it.each(NON_CANCELLABLE_STATUSES)(
    'rejects a %s slot with 409 SLOT_NOT_CANCELLABLE and changes nothing',
    async (status) => {
      const previousCancel =
        status === SlotStatus.CANCELLED
          ? new Date('2026-01-02T03:04:05.000Z')
          : null;
      const f = await seedScenario({ slotStatus: status, cancelledAt: previousCancel });
      authState.defaultUserId = f.callerClerkId;

      const res = await callCancel(f.slotId);
      expect(res.status).toBe(409);
      // No status, no slot data: the caller learns only that it is not allowed.
      expect(await res.json()).toEqual({
        error: 'Slot cannot be cancelled in its current state',
        code: 'SLOT_NOT_CANCELLABLE',
      });

      const slot = await snapshotSlot(f.slotId);
      expect(slot.status).toBe(status);
      expect(slot.cancelledAt).toEqual(previousCancel);
      const events = await prisma.payoutEvent.findMany({
        where: { slotId: f.slotId },
      });
      expect(events).toHaveLength(0);
    },
  );

  // =======================================================================
  // 6. Uniform 404s
  // =======================================================================

  interface NotFoundCase {
    name: string;
    seed: () => Promise<SeedResult>;
    callId: (f: SeedResult) => string;
  }

  const NOT_FOUND_CASES: NotFoundCase[] = [
    {
      name: 'a non-member caller',
      seed: () => seedScenario({ callerRole: 'NONE' }),
      callId: (f) => f.slotId,
    },
    {
      name: 'an unknown slot id',
      seed: () => seedScenario(),
      callId: () => 'slot_does_not_exist',
    },
    {
      name: 'a malformed slot id',
      seed: () => seedScenario(),
      callId: () => '../x',
    },
    {
      name: 'a soft-deleted slot',
      seed: () => seedScenario({ slotDeleted: true }),
      callId: (f) => f.slotId,
    },
    {
      name: 'a soft-deleted campaign',
      seed: () => seedScenario({ campaignDeleted: true }),
      callId: (f) => f.slotId,
    },
    {
      name: 'a member of a soft-deleted organization',
      seed: () => seedScenario({ orgDeleted: true, callerRole: 'OWNER' }),
      callId: (f) => f.slotId,
    },
  ];

  it.each(NOT_FOUND_CASES)(
    'returns 404 Not found for $name and changes nothing',
    async ({ seed, callId }) => {
      const f = await seed();
      authState.defaultUserId = f.callerClerkId;

      const res = await callCancel(callId(f));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(slot.status).toBe(SlotStatus.INVITED);
      expect(slot.cancelledAt).toBeNull();
    },
  );

  it('all six 404 bodies are byte-identical', async () => {
    const serialized: string[] = [];

    for (const scenario of NOT_FOUND_CASES) {
      const f = await scenario.seed();
      authState.defaultUserId = f.callerClerkId;
      const res = await callCancel(scenario.callId(f));
      expect(res.status).toBe(404);
      serialized.push(JSON.stringify(await res.json()));
    }

    expect(new Set(serialized).size).toBe(1);
    expect(serialized[0]).toBe(JSON.stringify({ error: 'Not found' }));
  });

  // =======================================================================
  // 7. Authorization outcomes
  // =======================================================================

  it('MEMBER role -> 403 Forbidden, slot unchanged', async () => {
    const f = await seedScenario({ callerRole: 'MEMBER' });
    authState.defaultUserId = f.callerClerkId;

    const res = await callCancel(f.slotId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.INVITED);
    expect(slot.cancelledAt).toBeNull();
  });

  it('unauthenticated -> 401 Unauthorized', async () => {
    const f = await seedScenario();
    authState.defaultUserId = null;

    const res = await callCancel(f.slotId);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.INVITED);
  });

  it('self-action: a creator who manages the org -> 403 SELF_ACTION_NOT_ALLOWED, slot unchanged', async () => {
    const f = await seedScenario({
      callerRole: 'OWNER',
      callerIsCreator: true,
    });
    authState.defaultUserId = f.callerClerkId;

    const res = await callCancel(f.slotId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You cannot cancel your own slot',
      code: 'SELF_ACTION_NOT_ALLOWED',
    });

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.INVITED);
    expect(slot.cancelledAt).toBeNull();
  });

  // =======================================================================
  // 8. The body is never read
  // =======================================================================

  it('ignores a non-JSON body and still cancels', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const res = await callCancel(f.slotId, { rawBody: '{not json' });
    expect(res.status).toBe(200);

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.CANCELLED);
  });

  it('ignores an oversized body and still cancels', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const oversized = JSON.stringify({ blob: 'x'.repeat(200_000) });
    const res = await callCancel(f.slotId, { rawBody: oversized });
    expect(res.status).toBe(200);

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.CANCELLED);
  });

  // =======================================================================
  // 9. Concurrency
  // =======================================================================

  it('5 parallel cancels give exactly one 200, the rest 409, and write cancelledAt once', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => callCancel(f.slotId)),
    );
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409, 409, 409, 409]);

    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const winnerBody = (await winners[0]!.json()) as { cancelledAt: string };

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.CANCELLED);
    expect(slot.cancelledAt).not.toBeNull();
    expect(winnerBody.cancelledAt).toBe(slot.cancelledAt!.toISOString());

    // A later read still sees the same timestamp: it was written once.
    const reread = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(reread.cancelledAt!.getTime()).toBe(slot.cancelledAt!.getTime());
  });

  it('cancel vs accept, 10 rounds: cancel always wins and accept never overwrites it', async () => {
    for (let round = 0; round < 10; round++) {
      const f = await seedScenario({ slotStatus: SlotStatus.INVITED });
      authState.defaultUserId = f.callerClerkId;

      const [cancelRes, acceptRes] = await Promise.all([
        callCancel(f.slotId),
        callAccept(f.slotId, f.creatorClerkId),
      ]);

      // Cancel matches INVITED *and* ACCEPTED, so an accept that slips in
      // between the read and the write cannot block it.
      expect(cancelRes.status).toBe(200);
      expect([200, 409]).toContain(acceptRes.status);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(slot.status).toBe(SlotStatus.CANCELLED);
      expect(slot.cancelledAt).not.toBeNull();
    }
  });

  it('cancel vs submit, 10 rounds: exactly one wins and the slot matches the winner', async () => {
    for (let round = 0; round < 10; round++) {
      const f = await seedScenario({ slotStatus: SlotStatus.ACCEPTED });
      authState.defaultUserId = f.callerClerkId;

      const [cancelRes, submitRes] = await Promise.all([
        callCancel(f.slotId),
        callSubmit(f.slotId, f.creatorClerkId, f.externalId),
      ]);

      expect(
        [cancelRes.status, submitRes.status].filter((s) => s === 200),
      ).toHaveLength(1);

      const slot = await snapshotSlot(f.slotId);
      if (cancelRes.status === 200) {
        expect(submitRes.status).toBe(409);
        expect(slot.status).toBe(SlotStatus.CANCELLED);
        expect(slot.contentId).toBeNull();
        expect(slot.platform).toBeNull();
      } else {
        expect(submitRes.status).toBe(200);
        expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
        expect(slot.contentId).toBe('vidCancelX1');
        expect(slot.platform).toBe(SocialPlatform.YOUTUBE);
      }
    }
  });

  // =======================================================================
  // 10. Campaign state is not a precondition
  // =======================================================================

  const NON_ACTIVE_CAMPAIGN_STATUSES: CampaignStatus[] = [
    CampaignStatus.DRAFT,
    CampaignStatus.PAUSED,
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
  ];

  it.each(NON_ACTIVE_CAMPAIGN_STATUSES)(
    'cancels an INVITED slot even when the campaign is %s',
    async (campaignStatus) => {
      const f = await seedScenario({ campaignStatus });
      authState.defaultUserId = f.callerClerkId;

      const res = await callCancel(f.slotId);
      expect(res.status).toBe(200);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(slot.status).toBe(SlotStatus.CANCELLED);
      expect(slot.cancelledAt).not.toBeNull();
    },
  );
});
