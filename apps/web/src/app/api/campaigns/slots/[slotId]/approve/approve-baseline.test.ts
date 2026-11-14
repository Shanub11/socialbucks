// apps/web/src/app/api/campaigns/slots/[slotId]/approve/approve-baseline.test.ts
//
// Real-database integration tests for the BASELINE release at approval
// (ADR-0003 D1) and the settlement window it starts (ADR-0003 D4).
//
// REQUIRES RUN_DB_TESTS=1 and a reachable Postgres at TEST_DATABASE_URL.
// If the DB is unreachable, the suite FAILS LOUDLY — it never silently skips.
//
// Only Clerk auth and the two YouTube helpers are mocked. Prisma is real and
// nothing about the database itself is faked.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignStatus,
  DisbursementStatus,
  MilestoneTier,
  Prisma,
  PrismaClient,
  SlotStatus,
  SocialPlatform,
} from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';

// Module-level mutable holder for the Clerk auth mock — reset in beforeEach.
const clerkAuthHolder: { userId: string | null } = { userId: null };

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/youtube/get-access-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/get-access-token')>();
  return { ...actual, getYoutubeAccessToken: vi.fn() };
});

vi.mock('@/lib/youtube/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/analytics')>();
  return { ...actual, verifyIsShort: vi.fn() };
});

import { auth } from '@clerk/nextjs/server';
import { getYoutubeAccessToken } from '@/lib/youtube/get-access-token';
import { verifyIsShort } from '@/lib/youtube/analytics';
import { POST } from './route';
import { resetTestDatabase } from '@/test/reset-test-db';
import { settleSlot, type MetricsProvider } from '@/lib/settlement/settle-slot';
import {
  baselineAmount,
  computeNewTiers,
  sumAllTierAmountsMinor,
} from '@/lib/settlement/tiers';
import { fromMinorUnits, toMinorUnits } from '@/lib/settlement/money';
import { settlementEndsAtFrom } from '@/lib/slots/constants';

const DAY_MS = 24 * 60 * 60 * 1000;

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — approve baseline tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

// ===========================================================================
// Pure arithmetic — no database needed, so it runs with or without RUN_DB_TESTS
// ===========================================================================

describe('approve baseline and tier arithmetic', () => {
  it.each(['100.03', '5.01', '33.33', '1000.00'])(
    'baseline + TIER_40 + TIER_70 + TIER_100 equals escrow exactly for %s',
    (escrow) => {
      const escrowAmount = new Prisma.Decimal(escrow);
      const escrowMinor = toMinorUnits(escrowAmount);

      const tiers = computeNewTiers(
        escrowAmount,
        1000,
        1_000_000,
        new Set<MilestoneTier>(),
      );
      const amountByTier = new Map(tiers.map((t) => [t.tier, t.amountMinor]));

      const baselineMinor = toMinorUnits(baselineAmount(escrowAmount));
      const total =
        baselineMinor +
        amountByTier.get(MilestoneTier.TIER_40)! +
        amountByTier.get(MilestoneTier.TIER_70)! +
        amountByTier.get(MilestoneTier.TIER_100)!;

      expect(total).toBe(escrowMinor);
      expect(sumAllTierAmountsMinor(escrowAmount)).toBe(escrowMinor);

      // The approval path and the settlement path must agree on BASELINE.
      expect(baselineMinor).toBe(amountByTier.get(MilestoneTier.BASELINE));
    },
  );

  it('settlement window is exactly 30 days of UTC milliseconds from approval', () => {
    // 2026-03-08 is a US DST transition day: calendar arithmetic would drift.
    const approvedAt = new Date('2026-03-08T01:30:00.000Z');
    const endsAt = settlementEndsAtFrom(approvedAt);

    expect(endsAt.getTime() - approvedAt.getTime()).toBe(30 * DAY_MS);
    expect(endsAt.toISOString()).toBe('2026-04-07T01:30:00.000Z');
  });
});

// ===========================================================================
// Real-database suite
// ===========================================================================

describeDb('POST /api/campaigns/slots/[slotId]/approve — BASELINE release', () => {
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
    // Reset the module-level holder so a forgotten setup fails loudly.
    clerkAuthHolder.userId = null;
    vi.mocked(getYoutubeAccessToken).mockResolvedValue('fake-access-token-123');
    vi.mocked(verifyIsShort).mockResolvedValue(true);
    await resetTestDatabase(prisma);
  });

  // -------------------------------------------------------------------------
  // seedScenario
  // -------------------------------------------------------------------------

  interface SeedOptions {
    callerRole?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'NONE';
    /** The caller is also the slot's creator (self-approval scenario). */
    callerIsCreator?: boolean;
    campaignStatus?: CampaignStatus;
    slotStatus?: SlotStatus;
    platform?: SocialPlatform;
    escrowAmount?: string;
    currency?: string;
    viewTarget?: number;
  }

  interface SeedResult {
    callerClerkId: string;
    slotId: string;
    organizationId: string;
    campaignId: string;
    creatorId: string;
    currency: string;
  }

  async function seedScenario(options: SeedOptions = {}): Promise<SeedResult> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const callerRole = options.callerRole ?? 'OWNER';
    const platform = options.platform ?? SocialPlatform.YOUTUBE;
    const escrowAmount = options.escrowAmount ?? '1000.00';

    // 1. Organization
    const org = await prisma.organization.create({
      data: { name: `Baseline Org ${suffix}` },
      select: { id: true },
    });

    // 2. Brand caller (the person calling the approve endpoint)
    const callerUser = await prisma.user.create({
      data: {
        clerkId: `clerk_baseline_caller_${suffix}`,
        email: `caller_${suffix}@test.local`,
      },
      select: { id: true, clerkId: true },
    });

    // 3. Organization membership (unless NONE)
    if (callerRole !== 'NONE') {
      await prisma.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: callerUser.id,
          role: callerRole,
        },
      });
    }

    // 4. The slot's creator: the caller itself only in the self-approval case.
    const creatorUserId = options.callerIsCreator
      ? callerUser.id
      : (
          await prisma.user.create({
            data: {
              clerkId: `clerk_baseline_creator_${suffix}`,
              email: `creator_${suffix}@test.local`,
            },
            select: { id: true },
          })
        ).id;

    const creator = await prisma.creator.create({
      data: { userId: creatorUserId },
      select: { id: true },
    });

    const socialAccount = await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform,
        externalId: `ext_${suffix}`,
        handle: `handle_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake.${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });

    // 5. Campaign
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Baseline Campaign ${suffix}`,
        totalBudget: new Prisma.Decimal(escrowAmount),
        currency: options.currency ?? 'USD',
        status: options.campaignStatus ?? CampaignStatus.ACTIVE,
        submissionDeadline: new Date(Date.now() + 30 * DAY_MS),
      },
      select: { id: true, currency: true },
    });

    // 6. Slot (CONTENT_SUBMITTED by default)
    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        escrowAmount: new Prisma.Decimal(escrowAmount),
        status: options.slotStatus ?? SlotStatus.CONTENT_SUBMITTED,
        platform,
        contentId: `vid_baseline_${suffix}`,
        socialAccountId: socialAccount.id,
        contentUrl: `https://youtube.com/shorts/vid_baseline_${suffix}`,
        submittedAt: new Date(),
        viewTarget: options.viewTarget ?? 1000,
        metric: 'engagedViews',
      },
      select: { id: true },
    });

    return {
      callerClerkId: callerUser.clerkId,
      slotId: slot.id,
      organizationId: org.id,
      campaignId: campaign.id,
      creatorId: creator.id,
      currency: campaign.currency,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function callApprove(slotId: string, body: unknown = {}): Promise<Response> {
    vi.mocked(auth).mockResolvedValue({
      userId: clerkAuthHolder.userId,
    } as never);
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      },
    );
    return POST(req, { params: Promise.resolve({ slotId }) });
  }

  /**
   * A rejected approval must leave the slot exactly as it was: no approval
   * timestamp, no settlement window, no cache movement, and no ledger row.
   */
  async function expectNoRelease(
    slotId: string,
    expectedStatus: SlotStatus = SlotStatus.CONTENT_SUBMITTED,
  ): Promise<void> {
    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
    });
    expect(slot.status).toBe(expectedStatus);
    expect(slot.approvedAt).toBeNull();
    expect(slot.settlementEndsAt).toBeNull();
    expect(slot.currentTier).toBeNull();
    expect(slot.paidToDate.toFixed(2)).toBe('0.00');

    const events = await prisma.payoutEvent.findMany({ where: { slotId } });
    expect(events).toHaveLength(0);
  }

  /** Fake MetricsProvider — only the analytics source is faked, never the DB. */
  function makeFakeMetrics(billableViews: number): MetricsProvider {
    return {
      async fetchMetrics() {
        return {
          billableViews,
          billableMetric: 'engagedViews',
          settlementSnapshot: { fake: true, billableViews },
        };
      },
    };
  }

  // =======================================================================
  // 1. The ledger row
  // =======================================================================

  it('releases exactly one BASELINE PayoutEvent with the campaign currency and no analytics fields', async () => {
    const f = await seedScenario({ escrowAmount: '1000.00', currency: 'USD' });
    clerkAuthHolder.userId = f.callerClerkId;

    const res = await callApprove(f.slotId);
    expect(res.status).toBe(200);

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.approvedAt).not.toBeNull();

    const events = await prisma.payoutEvent.findMany({
      where: { slotId: f.slotId },
    });
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event.slotId).toBe(f.slotId);
    expect(event.tier).toBe(MilestoneTier.BASELINE);
    // 20% of 1000.00, computed in integer minor units.
    expect(event.amount.toFixed(2)).toBe('200.00');
    expect(event.currency).toBe('USD');
    // A baseline released at approval has no analytics behind it.
    expect(event.billableViews).toBeNull();
    expect(event.billableMetric).toBeNull();
    expect(event.thresholdViews).toBeNull();
    // Money has not moved yet: disbursement stays at its default.
    expect(event.disbursementStatus).toBe(DisbursementStatus.PENDING);
    expect(event.settlementJson).toEqual({
      kind: 'BASELINE_AT_APPROVAL',
      approvedAt: slot.approvedAt!.toISOString(),
    });
  });

  // =======================================================================
  // 2. Slot cache and settlement window
  // =======================================================================

  it('starts the settlement window and money cache from one timestamp and returns them', async () => {
    const f = await seedScenario({ escrowAmount: '1000.00', viewTarget: 1000 });
    clerkAuthHolder.userId = f.callerClerkId;

    const res = await callApprove(f.slotId);
    const body = (await res.json()) as {
      status: SlotStatus;
      approvedAt: string;
      settlementEndsAt: string;
      currentTier: MilestoneTier;
      paidToDate: string;
    };
    expect(res.status).toBe(200);

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });

    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
    expect(slot.currentTier).toBe(MilestoneTier.BASELINE);
    expect(slot.paidToDate.toFixed(2)).toBe('200.00');
    expect(slot.approvedAt).not.toBeNull();
    expect(slot.settlementEndsAt).not.toBeNull();

    // Exactly 30 days of UTC milliseconds after approval — no local time.
    expect(slot.settlementEndsAt!.getTime()).toBe(
      slot.approvedAt!.getTime() + 30 * DAY_MS,
    );
    expect(slot.settlementEndsAt!.getTime() - slot.approvedAt!.getTime()).toBe(
      2_592_000_000,
    );

    // The response carries the same values the database holds.
    expect(body.status).toBe(SlotStatus.IN_PROGRESS);
    expect(body.currentTier).toBe(MilestoneTier.BASELINE);
    expect(body.paidToDate).toBe('200.00');
    expect(body.approvedAt).toBe(slot.approvedAt!.toISOString());
    expect(body.settlementEndsAt).toBe(slot.settlementEndsAt!.toISOString());
  });

  // =======================================================================
  // 3. Rounding
  // =======================================================================

  it.each([
    { escrow: '100.03', expected: '20.00' },
    { escrow: '33.33', expected: '6.66' },
    // 5.01 → 501 minor → 501 * 2000 / 10000 = 100.2 → 100 → 1.00
    { escrow: '5.01', expected: '1.00' },
  ])(
    'rounds the baseline down to whole minor units for escrow $escrow',
    async ({ escrow, expected }) => {
      const f = await seedScenario({ escrowAmount: escrow });
      clerkAuthHolder.userId = f.callerClerkId;

      // Independent expectation: floor(escrowMinor * 2000 / 10000).
      const escrowMinor = toMinorUnits(new Prisma.Decimal(escrow));
      const expectedMinor = (escrowMinor * 2000n) / 10000n;
      expect(fromMinorUnits(expectedMinor).toFixed(2)).toBe(expected);

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(200);

      const events = await prisma.payoutEvent.findMany({
        where: { slotId: f.slotId },
      });
      expect(events).toHaveLength(1);
      expect(toMinorUnits(events[0]!.amount)).toBe(expectedMinor);
      expect(events[0]!.amount.toFixed(2)).toBe(expected);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(toMinorUnits(slot.paidToDate)).toBe(expectedMinor);
      expect(slot.paidToDate.toFixed(2)).toBe(expected);
    },
  );

  // =======================================================================
  // 4. Atomicity
  // =======================================================================

  it('rolls back the whole approval when the BASELINE ledger row already exists', async () => {
    const f = await seedScenario({ escrowAmount: '1000.00' });
    clerkAuthHolder.userId = f.callerClerkId;

    // A ledger row the compare-and-swap cannot see: the slot is still
    // CONTENT_SUBMITTED, but BASELINE is already paid for it.
    await prisma.payoutEvent.create({
      data: {
        slotId: f.slotId,
        tier: MilestoneTier.BASELINE,
        amount: new Prisma.Decimal('200.00'),
        currency: f.currency,
        settlementJson: { kind: 'PREEXISTING_TEST_ROW' },
      },
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await callApprove(f.slotId);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });

      // The log carries the slot id and the Prisma code, nothing else.
      expect(errorSpy).toHaveBeenCalledWith(
        '[campaigns] slot approve baseline release failed',
        { slotId: f.slotId, code: 'P2002' },
      );
    } finally {
      errorSpy.mockRestore();
    }

    // The slot write in the same transaction was rolled back too.
    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
    expect(slot.approvedAt).toBeNull();
    expect(slot.settlementEndsAt).toBeNull();
    expect(slot.currentTier).toBeNull();
    expect(slot.paidToDate.toFixed(2)).toBe('0.00');

    const events = await prisma.payoutEvent.findMany({
      where: { slotId: f.slotId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.settlementJson).toEqual({ kind: 'PREEXISTING_TEST_ROW' });
  });

  // =======================================================================
  // 5. Concurrency
  // =======================================================================

  it('5 parallel approvals give exactly one 200, the rest 409, and exactly one ledger row', async () => {
    const f = await seedScenario({ escrowAmount: '1000.00' });
    clerkAuthHolder.userId = f.callerClerkId;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => callApprove(f.slotId)),
    );
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409, 409, 409, 409]);

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
    expect(slot.currentTier).toBe(MilestoneTier.BASELINE);
    expect(slot.paidToDate.toFixed(2)).toBe('200.00');

    // Only the compare-and-swap winner writes the ledger.
    const events = await prisma.payoutEvent.findMany({
      where: { slotId: f.slotId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.tier).toBe(MilestoneTier.BASELINE);
    expect(events[0]!.amount.toFixed(2)).toBe('200.00');
  });

  // =======================================================================
  // 6. Rejected paths write nothing
  // =======================================================================

  describe('rejected approvals release nothing', () => {
    it('self-approval → 403, no ledger row, no YouTube call', async () => {
      const f = await seedScenario({ callerRole: 'ADMIN', callerIsCreator: true });
      clerkAuthHolder.userId = f.callerClerkId;

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'You cannot approve your own content',
        code: 'SELF_APPROVAL_NOT_ALLOWED',
      });

      await expectNoRelease(f.slotId);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    it('non-member → 404, no ledger row, no YouTube call', async () => {
      const f = await seedScenario({ callerRole: 'NONE' });
      clerkAuthHolder.userId = f.callerClerkId;

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });

      await expectNoRelease(f.slotId);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    it('MEMBER role → 403, no ledger row, no YouTube call', async () => {
      const f = await seedScenario({ callerRole: 'MEMBER' });
      clerkAuthHolder.userId = f.callerClerkId;

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });

      await expectNoRelease(f.slotId);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    it('campaign not active → 409, no ledger row, no YouTube call', async () => {
      const f = await seedScenario({ campaignStatus: CampaignStatus.PAUSED });
      clerkAuthHolder.userId = f.callerClerkId;

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Campaign is not active',
        code: 'CAMPAIGN_NOT_ACTIVE',
      });

      await expectNoRelease(f.slotId);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    it('wrong slot status → 409, no ledger row, no YouTube call', async () => {
      const f = await seedScenario({ slotStatus: SlotStatus.ACCEPTED });
      clerkAuthHolder.userId = f.callerClerkId;

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(409);

      await expectNoRelease(f.slotId, SlotStatus.ACCEPTED);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    it('invalid body → 400, no ledger row, no YouTube call', async () => {
      const f = await seedScenario();
      clerkAuthHolder.userId = f.callerClerkId;

      const res = await callApprove(f.slotId, { viewTarget: 200_000 });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        'Invalid request body',
      );

      await expectNoRelease(f.slotId);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    it('unsupported platform → 422, no ledger row, no YouTube call', async () => {
      const f = await seedScenario({ platform: SocialPlatform.INSTAGRAM });
      clerkAuthHolder.userId = f.callerClerkId;

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: 'Approval is not yet available for this platform',
        code: 'PLATFORM_NOT_SUPPORTED',
        platform: SocialPlatform.INSTAGRAM,
      });

      await expectNoRelease(f.slotId);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    it('YouTube content not a Short → 422, no ledger row', async () => {
      const f = await seedScenario();
      clerkAuthHolder.userId = f.callerClerkId;
      vi.mocked(verifyIsShort).mockResolvedValue(false);

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(422);

      await expectNoRelease(f.slotId);
    });

    it('YouTube verification failure → 502, no ledger row', async () => {
      const f = await seedScenario();
      clerkAuthHolder.userId = f.callerClerkId;
      vi.mocked(verifyIsShort).mockRejectedValue(new Error('network blip'));

      const res = await callApprove(f.slotId);
      expect(res.status).toBe(502);

      await expectNoRelease(f.slotId);
    });
  });

  // =======================================================================
  // 7. Settlement compatibility
  // =======================================================================

  it('settleSlot below TIER_40 is NO_CHANGE and does not re-write BASELINE', async () => {
    const f = await seedScenario({ escrowAmount: '1000.00', viewTarget: 1000 });
    clerkAuthHolder.userId = f.callerClerkId;

    expect((await callApprove(f.slotId)).status).toBe(200);

    const outcome = await settleSlot(f.slotId, prisma, makeFakeMetrics(399));
    expect(outcome.status).toBe('NO_CHANGE');

    const events = await prisma.payoutEvent.findMany({
      where: { slotId: f.slotId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.tier).toBe(MilestoneTier.BASELINE);
    expect(events[0]!.amount.toFixed(2)).toBe('200.00');

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
    expect(slot.currentTier).toBe(MilestoneTier.BASELINE);
    expect(slot.paidToDate.toFixed(2)).toBe('200.00');
  });

  it('settleSlot above TIER_40 advances only TIER_40 and sums the ledger', async () => {
    const f = await seedScenario({ escrowAmount: '1000.00', viewTarget: 1000 });
    clerkAuthHolder.userId = f.callerClerkId;

    expect((await callApprove(f.slotId)).status).toBe(200);

    // TIER_40 needs 400 of the 1000 target views; TIER_70 needs 700.
    const outcome = await settleSlot(f.slotId, prisma, makeFakeMetrics(500));
    if (outcome.status !== 'ADVANCED') {
      throw new Error(`expected ADVANCED, got ${outcome.status}`);
    }
    expect(outcome.newTiers).toEqual([MilestoneTier.TIER_40]);

    const escrowMinor = toMinorUnits(new Prisma.Decimal('1000.00'));
    const baselineMinor = (escrowMinor * 2000n) / 10000n;
    const tier40Minor = (escrowMinor * 4000n) / 10000n - baselineMinor;
    const expectedPaid = fromMinorUnits(baselineMinor + tier40Minor);
    expect(expectedPaid.toFixed(2)).toBe('400.00');
    expect(outcome.paidToDate.toFixed(2)).toBe(expectedPaid.toFixed(2));

    const events = await prisma.payoutEvent.findMany({
      where: { slotId: f.slotId },
    });
    expect(events).toHaveLength(2);

    const byTier = new Map(events.map((e) => [e.tier, e]));
    const baselineRow = byTier.get(MilestoneTier.BASELINE)!;
    const tier40Row = byTier.get(MilestoneTier.TIER_40)!;

    // BASELINE was not re-written and still has no analytics fields.
    expect(baselineRow.amount.toFixed(2)).toBe('200.00');
    expect(baselineRow.billableViews).toBeNull();
    expect(baselineRow.settlementJson).toEqual({
      kind: 'BASELINE_AT_APPROVAL',
      approvedAt: expect.any(String),
    });

    expect(tier40Row.amount.toFixed(2)).toBe(
      fromMinorUnits(tier40Minor).toFixed(2),
    );
    expect(tier40Row.billableViews).toBe(500);
    expect(tier40Row.billableMetric).toBe('engagedViews');
    expect(tier40Row.thresholdViews).toBe(400);
    expect(tier40Row.currency).toBe(f.currency);

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
    expect(slot.currentTier).toBe(MilestoneTier.TIER_40);
    expect(slot.paidToDate.toFixed(2)).toBe(expectedPaid.toFixed(2));
  });
});
