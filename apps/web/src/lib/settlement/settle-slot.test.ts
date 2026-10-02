// apps/web/src/lib/settlement/settle-slot.test.ts
//
// Real-database integration tests for settleSlot().
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only MetricsProvider is faked. Prisma is real. No mocked DB.
//
// Run: RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... vitest run settle-slot.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient, MilestoneTier, SlotStatus, SocialPlatform } from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma } from '@repo/database';
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;;
import { settleSlot, type MetricsProvider, UnsupportedPlatformError } from './settle-slot';
import { instagramMetricsProvider } from './adapters/instagram';
import { OAuthHttpError } from '@/lib/oauth/request';

vi.mock('@/lib/crypto/secret-box', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto/secret-box')>();
  return {
    ...actual,
    decryptToken: vi.fn((_ciphertext: string, _platform: SocialPlatform) => 'fake-refresh-token-123'),
  };
});

vi.mock('@/lib/youtube/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/oauth')>();
  return {
    ...actual,
    refreshAccessToken: vi.fn(async (_refreshToken: string) => ({
      accessToken: 'fake-access-token-456',
      expiresAt: new Date(Date.now() + 3600_000),
    })),
  };
});

vi.mock('@/lib/youtube/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/analytics')>();
  return {
    ...actual,
    fetchVideoSettlement: vi.fn(
      async (_contentId: string, _startDate: string, _endDate: string, _accessToken: string) => ({
        views: 100,
        engagedViews: 50,
        estimatedMinutesWatched: 10,
        averageViewPercentage: 60,
        likes: 1,
        comments: 0,
        shares: 0,
        subscribersGained: 0,
        videosAddedToPlaylists: 0,
      }),
    ),
  };
});

// ---------------------------------------------------------------------------
// DB guard — fail loudly, never silently skip
// ---------------------------------------------------------------------------

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (RUN_DB_TESTS && !TEST_DATABASE_URL) {
  throw new Error(
    '[settle-slot.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.',
  );
}

if (RUN_DB_TESTS && TEST_DATABASE_URL) {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `[settle-slot.test] Refusing to run: database name "${dbName}" does not end in _test. ` +
      'Set TEST_DATABASE_URL to a _test database (e.g. socialbucks_test).',
    );
  }
}

// ---------------------------------------------------------------------------
// Test client
// ---------------------------------------------------------------------------

let prisma: PrismaClient;

if (RUN_DB_TESTS && TEST_DATABASE_URL) {
  const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
  prisma = new PrismaClient({ adapter });
}

// ---------------------------------------------------------------------------
// Test data factory helpers
// ---------------------------------------------------------------------------

interface SlotFixture {
  orgId: string;
  userId: string;
  creatorId: string;
  campaignId: string;
  socialAccountId: string;
  slotId: string;
}

async function createSlotFixture(
  db: PrismaClient,
  overrides: {
    platform?: SocialPlatform;
    isShort?: boolean | null;
    viewTarget?: number | null;
    status?: SlotStatus;
    escrowAmount?: string;
    currency?: string;
    tokenCiphertext?: string | null;
    revokedAt?: Date | null;
    approvedAt?: Date | null;
  } = {},
): Promise<SlotFixture> {
  const suffix = Math.random().toString(36).slice(2, 8);

  // User
  const user = await db.user.create({
    data: {
      clerkId: `clerk_test_${suffix}`,
      email: `test_${suffix}@example.com`,
    },
    select: { id: true },
  });

  // Organization
  const org = await db.organization.create({
    data: { name: `Test Org ${suffix}` },
    select: { id: true },
  });

  // Creator
  const creator = await db.creator.create({
    data: { userId: user.id },
    select: { id: true },
  });

  // SocialAccount
  const sa = await db.socialAccount.create({
    data: {
      creatorId: creator.id,
      platform: overrides.platform ?? SocialPlatform.YOUTUBE,
      externalId: `ext_${suffix}`,
      tokenCiphertext: overrides.tokenCiphertext !== undefined
        ? overrides.tokenCiphertext
        : `v1.fake_iv.fake_tag.fake_ct_${suffix}`,
      scopes: ['yt-analytics.readonly'],
      revokedAt: overrides.revokedAt !== undefined ? overrides.revokedAt : null,
    },
    select: { id: true },
  });

  // Campaign
  const campaign = await db.campaign.create({
    data: {
      organizationId: org.id,
      title: `Test Campaign ${suffix}`,
      totalBudget: new Decimal(overrides.escrowAmount ?? '1000.00'),
      currency: overrides.currency ?? 'USD',
    },
    select: { id: true },
  });

  // Slot
  const slot = await db.campaignCreatorSlot.create({
    data: {
      campaignId: campaign.id,
      creatorId: creator.id,
      status: overrides.status ?? SlotStatus.IN_PROGRESS,
      escrowAmount: new Decimal(overrides.escrowAmount ?? '1000.00'),
      platform: overrides.platform ?? SocialPlatform.YOUTUBE,
      contentId: `vid_${suffix}`,
      socialAccountId: sa.id,
      isShort: overrides.isShort !== undefined ? overrides.isShort : true,
      viewTarget: overrides.viewTarget !== undefined ? overrides.viewTarget : 100000,
      approvedAt: overrides.approvedAt !== undefined ? overrides.approvedAt : new Date('2026-01-01T00:00:00Z'),
    },
    select: { id: true },
  });

  return {
    orgId: org.id,
    userId: user.id,
    creatorId: creator.id,
    campaignId: campaign.id,
    socialAccountId: sa.id,
    slotId: slot.id,
  };
}

/** Fake MetricsProvider that returns configurable view counts. */
function makeFakeMetrics(billableViews: number, metric = 'engagedViews'): MetricsProvider {
  return {
    async fetchMetrics() {
      return {
        billableViews,
        billableMetric: metric,
        settlementSnapshot: { fake: true, billableViews },
      };
    },
  };
}

/** Fake MetricsProvider that throws OAuthHttpError(404). */
const noDataMetrics: MetricsProvider = {
  async fetchMetrics() {
    throw new OAuthHttpError('No analytics data', { status: 404 });
  },
};

/** Fake MetricsProvider that throws a generic error (provider failure). */
const failingMetrics: MetricsProvider = {
  async fetchMetrics() {
    throw new Error('Network timeout fetching analytics');
  },
};

// ---------------------------------------------------------------------------
// Cleanup helper — deletes all test rows for a slot fixture
// ---------------------------------------------------------------------------

async function cleanSlotFixture(db: PrismaClient, f: SlotFixture): Promise<void> {
  // Delete in FK-safe order
  await db.payoutEvent.deleteMany({ where: { slotId: f.slotId } });
  await db.campaignCreatorSlot.deleteMany({ where: { id: f.slotId } });
  await db.campaign.deleteMany({ where: { id: f.campaignId } });
  await db.socialAccount.deleteMany({ where: { id: f.socialAccountId } });
  await db.creator.deleteMany({ where: { id: f.creatorId } });
  await db.user.deleteMany({ where: { id: f.userId } });
  await db.organization.deleteMany({ where: { id: f.orgId } });
}

// ---------------------------------------------------------------------------
// Tests — only run when RUN_DB_TESTS=1
// ---------------------------------------------------------------------------

const describeIf = (condition: boolean) =>
  condition ? describe : describe.skip;

describeIf(RUN_DB_TESTS)('settleSlot — real DB', () => {
  beforeAll(async () => {
    // Verify DB is reachable — fail loudly if not
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `[settle-slot.test] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Single-tier advance
  // -------------------------------------------------------------------------

  describe('single-tier advance', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma, { viewTarget: 100000 }); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('advances to BASELINE when views >= 20000', async () => {
      const result = await settleSlot(f.slotId, prisma, makeFakeMetrics(20000));
      expect(result.status).toBe('ADVANCED');
      if (result.status !== 'ADVANCED') throw new Error('unreachable');
      expect(result.newTiers).toEqual([MilestoneTier.BASELINE]);
      expect(result.paidToDate.toNumber()).toBeCloseTo(200.00, 2);

      const events = await prisma.payoutEvent.findMany({ where: { slotId: f.slotId } });
      expect(events).toHaveLength(1);
      expect(events[0]!.tier).toBe(MilestoneTier.BASELINE);
      expect(events[0]!.disbursementStatus).toBe('PENDING');
      expect(events[0]!.billableMetric).toBe('engagedViews');
    });
  });

  // -------------------------------------------------------------------------
  // Skipped tiers — all paid in one transaction (3 rows)
  // -------------------------------------------------------------------------

  describe('skipped tiers', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma, { viewTarget: 100000 }); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('75% of target creates BASELINE+TIER_40+TIER_70 in one call', async () => {
      const result = await settleSlot(f.slotId, prisma, makeFakeMetrics(75000));
      expect(result.status).toBe('ADVANCED');
      if (result.status !== 'ADVANCED') throw new Error('unreachable');
      expect(result.newTiers).toEqual([
        MilestoneTier.BASELINE,
        MilestoneTier.TIER_40,
        MilestoneTier.TIER_70,
      ]);

      const events = await prisma.payoutEvent.findMany({
        where: { slotId: f.slotId },
        orderBy: { createdAt: 'asc' },
      });
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.tier)).toEqual([
        MilestoneTier.BASELINE,
        MilestoneTier.TIER_40,
        MilestoneTier.TIER_70,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Second sequential run is NO_CHANGE — ledger unchanged
  // -------------------------------------------------------------------------

  describe('idempotent sequential run', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma, { viewTarget: 100000 }); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('second run with same views returns NO_CHANGE without touching the ledger', async () => {
      await settleSlot(f.slotId, prisma, makeFakeMetrics(20000));
      const countBefore = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });

      const result = await settleSlot(f.slotId, prisma, makeFakeMetrics(20000));
      expect(result.status).toBe('NO_CHANGE');

      const countAfter = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
      expect(countAfter).toBe(countBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent calls — exactly one row per tier, paidToDate = ledger sum
  // -------------------------------------------------------------------------

  describe('concurrent idempotency', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma, { viewTarget: 100000, escrowAmount: '1000.00' }); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('5 concurrent settleSlot calls leave exactly one row per tier', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          settleSlot(f.slotId, prisma, makeFakeMetrics(20000)),
        ),
      );

      // At least one must have ADVANCED; others must be NO_CHANGE
      const advanced = results.filter((r) => r.status === 'ADVANCED');
      const noChange = results.filter((r) => r.status === 'NO_CHANGE');
      expect(advanced.length + noChange.length).toBe(5);
      expect(advanced.length).toBeGreaterThanOrEqual(1);

      // Exactly one PayoutEvent row for BASELINE
      const events = await prisma.payoutEvent.findMany({ where: { slotId: f.slotId } });
      expect(events).toHaveLength(1);
      expect(events[0]!.tier).toBe(MilestoneTier.BASELINE);

      // paidToDate equals ledger sum
      const slot = await prisma.campaignCreatorSlot.findUnique({
        where: { id: f.slotId },
        select: { paidToDate: true },
      });
      expect(slot!.paidToDate.toNumber()).toBeCloseTo(200.00, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Downward view revision — no change, no clawback
  // -------------------------------------------------------------------------

  describe('downward view revision', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma, { viewTarget: 100000 }); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('lower view count after first advance returns NO_CHANGE, ledger unchanged', async () => {
      await settleSlot(f.slotId, prisma, makeFakeMetrics(40000)); // BASELINE + TIER_40

      const countBefore = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });

      const result = await settleSlot(f.slotId, prisma, makeFakeMetrics(5000)); // below BASELINE
      expect(result.status).toBe('NO_CHANGE');

      const countAfter = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
      expect(countAfter).toBe(countBefore); // nothing clawed back
    });
  });

  // -------------------------------------------------------------------------
  // DISPUTED slot — no writes
  // -------------------------------------------------------------------------

  describe('DISPUTED slot', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma, { status: SlotStatus.DISPUTED }); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('returns SKIPPED_NOT_ELIGIBLE, writes nothing', async () => {
      const result = await settleSlot(f.slotId, prisma, makeFakeMetrics(100000));
      expect(result.status).toBe('SKIPPED_NOT_ELIGIBLE');
      if (result.status !== 'SKIPPED_NOT_ELIGIBLE') throw new Error('unreachable');
      expect(result.reason).toBe('slot_not_in_progress');

      const events = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
      expect(events).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // D3 — YOUTUBE isShort null/false → HELD, no writes
  // -------------------------------------------------------------------------

  describe('YOUTUBE isShort guard (D3)', () => {
    it('isShort=null → HELD, no writes', async () => {
      const f = await createSlotFixture(prisma, { isShort: null });
      try {
        const result = await settleSlot(f.slotId, prisma, makeFakeMetrics(100000));
        expect(result.status).toBe('SKIPPED_NOT_ELIGIBLE');
        if (result.status !== 'SKIPPED_NOT_ELIGIBLE') throw new Error('unreachable');
        expect(result.reason).toBe('youtube_not_short');
        const events = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
        expect(events).toBe(0);
      } finally {
        await cleanSlotFixture(prisma, f);
      }
    });

    it('isShort=false → HELD, no writes', async () => {
      const f = await createSlotFixture(prisma, { isShort: false });
      try {
        const result = await settleSlot(f.slotId, prisma, makeFakeMetrics(100000));
        expect(result.status).toBe('SKIPPED_NOT_ELIGIBLE');
        if (result.status !== 'SKIPPED_NOT_ELIGIBLE') throw new Error('unreachable');
        expect(result.reason).toBe('youtube_not_short');
        const events = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
        expect(events).toBe(0);
      } finally {
        await cleanSlotFixture(prisma, f);
      }
    });
  });

  // -------------------------------------------------------------------------
  // TIER_100 → COMPLETED, paidToDate == escrowAmount exactly
  // -------------------------------------------------------------------------

  describe('TIER_100 → COMPLETED', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma, { viewTarget: 100, escrowAmount: '1000.00' }); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('100 views → COMPLETED with paidToDate == escrowAmount exactly', async () => {
      const result = await settleSlot(f.slotId, prisma, makeFakeMetrics(100));
      expect(result.status).toBe('ADVANCED');
      if (result.status !== 'ADVANCED') throw new Error('unreachable');
      expect(result.newTiers).toContain(MilestoneTier.TIER_100);

      // paidToDate must equal escrowAmount exactly (no float drift)
      expect(result.paidToDate.toString()).toBe('1000');

      const slot = await prisma.campaignCreatorSlot.findUnique({
        where: { id: f.slotId },
        select: { status: true, paidToDate: true },
      });
      expect(slot!.status).toBe(SlotStatus.COMPLETED);
      expect(slot!.paidToDate.toString()).toBe('1000');
    });
  });

  // -------------------------------------------------------------------------
  // DB-level idempotency: direct duplicate insert rejected by constraint
  // This proves the guard is the constraint, not application code
  // -------------------------------------------------------------------------

  describe('DB-level idempotency constraint', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('direct duplicate (slotId, tier) insert is rejected by the database', async () => {
      // First insert — should succeed
      await prisma.payoutEvent.create({
        data: {
          slotId: f.slotId,
          tier: MilestoneTier.BASELINE,
          amount: new Decimal('200.00'),
          currency: 'USD',
          billableViews: 20000,
          billableMetric: 'engagedViews',
          thresholdViews: 20000,
          settlementJson: { test: true },
        },
      });

      // Second insert with same (slotId, tier) — must throw P2002 from the DB
      await expect(
        prisma.payoutEvent.create({
          data: {
            slotId: f.slotId,
            tier: MilestoneTier.BASELINE,
            amount: new Decimal('200.00'),
            currency: 'USD',
            billableViews: 25000,
            billableMetric: 'engagedViews',
            thresholdViews: 20000,
            settlementJson: { test: true },
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // -------------------------------------------------------------------------
  // Provider failure — zero writes
  // -------------------------------------------------------------------------

  describe('provider failure', () => {
    let f: SlotFixture;
    beforeEach(async () => { f = await createSlotFixture(prisma); });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('throws and leaves zero writes when analytics provider fails', async () => {
      await expect(
        settleSlot(f.slotId, prisma, failingMetrics),
      ).rejects.toThrow('Network timeout');

      const events = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
      expect(events).toBe(0);
    });

    it('returns HELD_NO_DATA when provider returns OAuthHttpError(404)', async () => {
      const result = await settleSlot(f.slotId, prisma, noDataMetrics);
      expect(result.status).toBe('HELD_NO_DATA');
      const events = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
      expect(events).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // INSTAGRAM platform — clean skip via UnsupportedPlatformError
  // -------------------------------------------------------------------------

  describe('INSTAGRAM platform — unsupported platform skips cleanly', () => {
    let f: SlotFixture;
    beforeEach(async () => {
      f = await createSlotFixture(prisma, { platform: SocialPlatform.INSTAGRAM });
    });
    afterAll(async () => { if (f) await cleanSlotFixture(prisma, f); });

    it('returns SKIPPED_NOT_ELIGIBLE with platform_not_supported, zero writes', async () => {
      const result = await settleSlot(f.slotId, prisma, instagramMetricsProvider);
      expect(result.status).toBe('SKIPPED_NOT_ELIGIBLE');
      if (result.status !== 'SKIPPED_NOT_ELIGIBLE') throw new Error('unreachable');
      expect(result.reason).toBe('platform_not_supported');

      const events = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
      expect(events).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// YouTube adapter wiring test (light, no real network)
// ---------------------------------------------------------------------------

describe('YouTube adapter wiring', () => {
  it('decrypts with YOUTUBE platform, uses the refreshed access token, and passes the date range through unchanged', async () => {
    const { youtubeMetricsProvider } = await import('./adapters/youtube');
    const { decryptToken } = await import('@/lib/crypto/secret-box');
    const { fetchVideoSettlement } = await import('@/lib/youtube/analytics');

    await youtubeMetricsProvider.fetchMetrics({
      platform: SocialPlatform.YOUTUBE,
      contentId: 'vid_abc123',
      startDate: '2026-01-01',
      endDate: '2026-09-30',
      accessToken: 'v1.fake.ciphertext.value',
    });

    // Proves decryptToken was called with YOUTUBE specifically, not some
    // other platform's key, and with the exact ciphertext that was passed in.
    expect(decryptToken).toHaveBeenCalledWith(
      'v1.fake.ciphertext.value',
      SocialPlatform.YOUTUBE,
    );

    // Proves the refreshed access token (not the ciphertext, not the
    // refresh token) is what actually reaches the analytics call, and
    // that the date range flows through unmodified.
    expect(fetchVideoSettlement).toHaveBeenCalledWith(
      'vid_abc123',
      '2026-01-01',
      '2026-09-30',
      'fake-access-token-456',
    );
  });
});

