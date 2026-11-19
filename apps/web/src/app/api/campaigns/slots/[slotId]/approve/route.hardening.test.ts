// apps/web/src/app/api/campaigns/slots/[slotId]/approve/route.hardening.test.ts
//
// Hardening integration tests for POST /api/campaigns/slots/[slotId]/approve.
// REQUIRES RUN_DB_TESTS=1 and a reachable Postgres at TEST_DATABASE_URL.
// If the DB is unreachable, the suite FAILS LOUDLY — it never silently skips.
//
// Only Clerk auth and YouTube verification are mocked. Prisma is real.
// Uses REAL provisioning: User rows are seeded directly and the Clerk
// auth holder is set to the caller's clerkId (not the database UUID).

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignStatus,
  MilestoneTier,
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

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — approve hardening tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;


describeDb('POST /api/campaigns/slots/[slotId]/approve — hardening', () => {
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
    campaignStatus?: CampaignStatus;
    campaignDeleted?: boolean;
    slotStatus?: SlotStatus;
    slotDeleted?: boolean;
    orgDeleted?: boolean;
    callerDeleted?: boolean;
  }

  interface SeedResult {
    callerClerkId: string;
    slotId: string;
    organizationId: string;
    campaignId: string;
  }

  async function seedScenario(options: SeedOptions = {}): Promise<SeedResult> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const callerRole = options.callerRole ?? 'OWNER';

    // 1. Organization
    const org = await prisma.organization.create({
      data: {
        name: `Harden Org ${suffix}`,
        deletedAt: options.orgDeleted ? new Date() : null,
      },
    });

    // 2. Brand caller (the person calling the approve endpoint)
    const callerUser = await prisma.user.create({
      data: {
        clerkId: `clerk_harden_caller_${suffix}`,
        email: `caller_${suffix}@test.local`,
        deletedAt: options.callerDeleted ? new Date() : null,
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

    // 4. Separate creator user + Creator + YOUTUBE SocialAccount
    const creatorUser = await prisma.user.create({
      data: {
        clerkId: `clerk_harden_creator_${suffix}`,
        email: `creator_${suffix}@test.local`,
      },
      select: { id: true },
    });

    const creator = await prisma.creator.create({
      data: { userId: creatorUser.id },
    });

    const socialAccount = await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId: `ext_${suffix}`,
        handle: `handle_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake.${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });

    // 5. Campaign (ACTIVE by default, future submissionDeadline)
    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Harden Campaign ${suffix}`,
        totalBudget: 1000,
        currency: 'USD',
        status: options.campaignStatus ?? CampaignStatus.ACTIVE,
        submissionDeadline: new Date(Date.now() + 30 * 86_400_000),
        deletedAt: options.campaignDeleted ? new Date() : null,
      },
    });

    // 6. Slot (CONTENT_SUBMITTED by default)
    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        escrowAmount: '40.00',
        status: options.slotStatus ?? SlotStatus.CONTENT_SUBMITTED,
        platform: SocialPlatform.YOUTUBE,
        contentId: `vid_harden_${suffix}`,
        socialAccountId: socialAccount.id,
        contentUrl: `https://youtube.com/shorts/vid_harden_${suffix}`,
        submittedAt: new Date(),
        viewTarget: 1000,
        metric: 'engagedViews',
        deletedAt: options.slotDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    return {
      callerClerkId: callerUser.clerkId,
      slotId: slot.id,
      organizationId: org.id,
      campaignId: campaign.id,
    };
  }

  // -------------------------------------------------------------------------
  // callApprove: sets Clerk holder and invokes the POST handler.
  // -------------------------------------------------------------------------

  function callApprove(slotId: string): Promise<Response> {
    vi.mocked(auth).mockResolvedValue({
      userId: clerkAuthHolder.userId,
    } as never);
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      },
    );
    return POST(req, { params: Promise.resolve({ slotId }) });
  }

  // =======================================================================
  // describe('approve — campaign guard')
  // =======================================================================

  describe('approve — campaign guard', () => {
    const NON_ACTIVE_STATUSES: CampaignStatus[] = [
      CampaignStatus.DRAFT,
      CampaignStatus.PAUSED,
      CampaignStatus.COMPLETED,
      CampaignStatus.CANCELLED,
    ];

    it.each(NON_ACTIVE_STATUSES)(
      'returns 409 CAMPAIGN_NOT_ACTIVE when campaign status is %s',
      async (status) => {
        const { callerClerkId, slotId } = await seedScenario({
          campaignStatus: status,
        });
        clerkAuthHolder.userId = callerClerkId;

        const res = await callApprove(slotId);
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body).toEqual({
          error: 'Campaign is not active',
          code: 'CAMPAIGN_NOT_ACTIVE',
        });

        // Slot must still be CONTENT_SUBMITTED
        const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
          where: { id: slotId },
        });
        expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

        // Zero PayoutEvent rows
        const events = await prisma.payoutEvent.findMany({
          where: { slotId },
        });
        expect(events).toHaveLength(0);

        // Neither YouTube mock was called
        expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
        expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
      },
    );

    it('returns 409 CAMPAIGN_NOT_ACTIVE when campaign is soft-deleted', async () => {
      const { callerClerkId, slotId } = await seedScenario({
        campaignDeleted: true,
      });
      clerkAuthHolder.userId = callerClerkId;

      const res = await callApprove(slotId);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'Campaign is not active',
        code: 'CAMPAIGN_NOT_ACTIVE',
      });

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

      const events = await prisma.payoutEvent.findMany({
        where: { slotId },
      });
      expect(events).toHaveLength(0);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    it('positive control: ACTIVE campaign returns 200, slot is IN_PROGRESS', async () => {
      const { callerClerkId, slotId } = await seedScenario();
      clerkAuthHolder.userId = callerClerkId;

      const res = await callApprove(slotId);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe(SlotStatus.IN_PROGRESS);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
    });
  });

  // =======================================================================
  // describe('approve — authorization uniformity')
  // =======================================================================

  describe('approve — authorization uniformity', () => {
    const EXPECTED_404 = { error: 'Not found' };

    // -- malformed slot ids --------------------------------------------------

    const MALFORMED_IDS = ['../x', 'a b', 'x'.repeat(65)];

    it.each(MALFORMED_IDS)(
      'malformed slotId %j → 404 Not found',
      async (badId) => {
        const { callerClerkId, slotId } = await seedScenario();
        clerkAuthHolder.userId = callerClerkId;

        const res = await callApprove(badId);
        const body = await res.json();

        expect(res.status).toBe(404);
        expect(body).toEqual(EXPECTED_404);

        const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
          where: { id: slotId },
        });
        expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

        expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
        expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
      },
    );

    // -- unknown slot id -----------------------------------------------------

    it('unknown slot id → 404 Not found', async () => {
      const { callerClerkId, slotId } = await seedScenario();
      clerkAuthHolder.userId = callerClerkId;

      const res = await callApprove('slot_does_not_exist');
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    // -- soft-deleted slot ---------------------------------------------------

    it('soft-deleted slot → 404 Not found', async () => {
      const { callerClerkId, slotId } = await seedScenario({
        slotDeleted: true,
      });
      clerkAuthHolder.userId = callerClerkId;

      const res = await callApprove(slotId);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    // -- caller not a member of any org --------------------------------------

    it('caller not a member of any org → 404 Not found', async () => {
      const { callerClerkId, slotId } = await seedScenario({
        callerRole: 'NONE',
      });
      clerkAuthHolder.userId = callerClerkId;

      const res = await callApprove(slotId);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    // -- caller is member of a DIFFERENT org only ----------------------------

    it('caller member of different org only → 404 Not found', async () => {
      const { callerClerkId, slotId } = await seedScenario({
        callerRole: 'NONE',
      });
      // Create a separate org and add the caller as OWNER there.
      const callerUser = await prisma.user.findUniqueOrThrow({
        where: { clerkId: callerClerkId },
        select: { id: true },
      });
      const otherOrg = await prisma.organization.create({
        data: { name: 'Other Org' },
      });
      await prisma.organizationMember.create({
        data: {
          organizationId: otherOrg.id,
          userId: callerUser.id,
          role: 'OWNER',
        },
      });
      clerkAuthHolder.userId = callerClerkId;

      const res = await callApprove(slotId);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    // -- caller is OWNER of a soft-deleted org -------------------------------

    it('OWNER of soft-deleted org → 404 Not found', async () => {
      const { callerClerkId, slotId } = await seedScenario({
        orgDeleted: true,
      });
      clerkAuthHolder.userId = callerClerkId;

      const res = await callApprove(slotId);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    // -- all six 404 bodies are identical ------------------------------------

    it('all six 404 denial bodies are deep-equal to each other', async () => {
      // Seed a base scenario (OWNER) so we have a real slot.
      const base = await seedScenario();
      clerkAuthHolder.userId = base.callerClerkId;

      // 1. malformed id
      const r1 = await callApprove('../x');
      const b1 = await r1.json();

      // 2. unknown id
      const r2 = await callApprove('slot_does_not_exist');
      const b2 = await r2.json();

      // 3. soft-deleted slot
      const delSlot = await seedScenario({ slotDeleted: true });
      clerkAuthHolder.userId = delSlot.callerClerkId;
      const r3 = await callApprove(delSlot.slotId);
      const b3 = await r3.json();

      // 4. non-member caller
      const noMember = await seedScenario({ callerRole: 'NONE' });
      clerkAuthHolder.userId = noMember.callerClerkId;
      const r4 = await callApprove(noMember.slotId);
      const b4 = await r4.json();

      // 5. caller in different org only
      const diffOrg = await seedScenario({ callerRole: 'NONE' });
      const diffUser = await prisma.user.findUniqueOrThrow({
        where: { clerkId: diffOrg.callerClerkId },
        select: { id: true },
      });
      const anotherOrg = await prisma.organization.create({
        data: { name: 'Diff Org' },
      });
      await prisma.organizationMember.create({
        data: {
          organizationId: anotherOrg.id,
          userId: diffUser.id,
          role: 'OWNER',
        },
      });
      clerkAuthHolder.userId = diffOrg.callerClerkId;
      const r5 = await callApprove(diffOrg.slotId);
      const b5 = await r5.json();

      // 6. OWNER of soft-deleted org
      const softOrg = await seedScenario({ orgDeleted: true });
      clerkAuthHolder.userId = softOrg.callerClerkId;
      const r6 = await callApprove(softOrg.slotId);
      const b6 = await r6.json();

      const bodies = [b1, b2, b3, b4, b5, b6];
      for (const b of bodies) {
        expect(b).toEqual(EXPECTED_404);
      }
    });

    // -- MEMBER role → 403 ---------------------------------------------------

    it('MEMBER-role caller → 403 Forbidden, slot unchanged', async () => {
      const { callerClerkId, slotId } = await seedScenario({
        callerRole: 'MEMBER',
      });
      clerkAuthHolder.userId = callerClerkId;

      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });

      const res = await callApprove(slotId);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body).toEqual({ error: 'Forbidden' });

      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(after).toEqual(before);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    // -- soft-deleted caller → 403 Account disabled --------------------------

    it('soft-deleted caller → 403 Account disabled, no reason property', async () => {
      const { callerClerkId, slotId } = await seedScenario({
        callerDeleted: true,
      });
      clerkAuthHolder.userId = callerClerkId;

      const res = await callApprove(slotId);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body).toEqual({ error: 'Account disabled' });
      expect(body).not.toHaveProperty('reason');

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    });

    // -- no leaked info in denial bodies -------------------------------------

    it('no denial body contains a clerk id or slot status text', async () => {
      // Collect bodies from every denial scenario.
      const bodies: unknown[] = [];

      // 404: malformed id
      const base = await seedScenario();
      clerkAuthHolder.userId = base.callerClerkId;
      bodies.push(await (await callApprove('../x')).json());

      // 404: unknown id
      bodies.push(await (await callApprove('slot_does_not_exist')).json());

      // 404: soft-deleted slot
      const delSlot = await seedScenario({ slotDeleted: true });
      clerkAuthHolder.userId = delSlot.callerClerkId;
      bodies.push(await (await callApprove(delSlot.slotId)).json());

      // 404: non-member
      const noMem = await seedScenario({ callerRole: 'NONE' });
      clerkAuthHolder.userId = noMem.callerClerkId;
      bodies.push(await (await callApprove(noMem.slotId)).json());

      // 403: MEMBER
      const mem = await seedScenario({ callerRole: 'MEMBER' });
      clerkAuthHolder.userId = mem.callerClerkId;
      bodies.push(await (await callApprove(mem.slotId)).json());

      // 403: soft-deleted caller
      const del = await seedScenario({ callerDeleted: true });
      clerkAuthHolder.userId = del.callerClerkId;
      bodies.push(await (await callApprove(del.slotId)).json());

      for (const b of bodies) {
        const serialized = JSON.stringify(b);
        // No clerk id substring (all test clerk ids start with 'clerk_')
        expect(serialized).not.toContain('clerk_');
        // No slot status enum text
        expect(serialized).not.toContain('CONTENT_SUBMITTED');
        expect(serialized).not.toContain('IN_PROGRESS');
        expect(serialized).not.toContain('ACCEPTED');
        expect(serialized).not.toContain('INVITED');
      }
    });
  });

  // =======================================================================
  // describe('approve — concurrency')
  // =======================================================================

  describe('approve — concurrency', () => {
    it('10 rounds of simultaneous approvals produce exactly one 200 and one 409 per round', async () => {
      const ROUNDS = 10;

      for (let round = 0; round < ROUNDS; round++) {
        vi.mocked(verifyIsShort).mockClear();
        vi.mocked(getYoutubeAccessToken).mockClear();

        const { callerClerkId, slotId } = await seedScenario();
        clerkAuthHolder.userId = callerClerkId;

        const [res1, res2] = await Promise.all([
          callApprove(slotId),
          callApprove(slotId),
        ]);

        const statuses = [res1.status, res2.status].sort((a, b) => a - b);
        expect(statuses).toEqual([200, 409]);

        const slot1 = await prisma.campaignCreatorSlot.findUniqueOrThrow({
          where: { id: slotId },
        });
        expect(slot1.status).toBe(SlotStatus.IN_PROGRESS);
        expect(slot1.approvedAt).not.toBeNull();

        const events = await prisma.payoutEvent.findMany({
          where: { slotId },
        });
        // Two simultaneous approvals: only the compare-and-swap winner writes the ledger.
        expect(events).toHaveLength(1);
        expect(events[0]?.tier).toBe(MilestoneTier.BASELINE);

        const verifyCalls = vi.mocked(verifyIsShort).mock.calls.length;
        expect(verifyCalls).toBeGreaterThanOrEqual(1);
        expect(verifyCalls).toBeLessThanOrEqual(2);

        // Re-read slot to confirm approvedAt did not change between two reads
        const slot2 = await prisma.campaignCreatorSlot.findUniqueOrThrow({
          where: { id: slotId },
        });
        expect(slot2.approvedAt).toEqual(slot1.approvedAt);
      }
    });
  });
});
