// apps/web/src/app/api/campaigns/slots/[slotId]/submit/route.hardening.test.ts
//
// Hardening integration tests for POST /api/campaigns/slots/[slotId]/submit.
// REQUIRES RUN_DB_TESTS=1 and a reachable Postgres at TEST_DATABASE_URL.
// Only Clerk auth and YouTube ownership are mocked. Prisma is real.
// Uses REAL provisioning: User rows are seeded directly and the Clerk
// auth holder is set to the caller's clerkId (not the database UUID).

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignStatus,
  MilestoneTier,
  Prisma,
  PrismaClient,
  SlotStatus,
  SocialPlatform,
} from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';

const clerkAuthHolder: { userId: string | null } = { userId: null };

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/youtube/get-access-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/get-access-token')>();
  return { ...actual, getYoutubeAccessToken: vi.fn() };
});

vi.mock('@/lib/youtube/video-ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/video-ownership')>();
  return { ...actual, fetchVideoChannel: vi.fn() };
});

import { auth } from '@clerk/nextjs/server';
import { getYoutubeAccessToken } from '@/lib/youtube/get-access-token';
import { fetchVideoChannel } from '@/lib/youtube/video-ownership';
import { POST } from './route';
import { resetTestDatabase } from '@/test/reset-test-db';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn('RUN_DB_TESTS != 1 — submit hardening tests are SKIPPED, not passing.');
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;
const DEFAULT_SUBMIT_URL = 'https://www.youtube.com/shorts/dQw4w9WgXcQ';

describeDb('POST /api/campaigns/slots/[slotId]/submit — hardening', () => {
  if (process.env.RUN_DB_TESTS === '1' && !process.env.TEST_DATABASE_URL) {
    throw new Error('RUN_DB_TESTS=1 but TEST_DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL ?? '' }),
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    clerkAuthHolder.userId = null;
    vi.mocked(getYoutubeAccessToken).mockReset();
    vi.mocked(fetchVideoChannel).mockReset();
    vi.mocked(getYoutubeAccessToken).mockRejectedValue(
      new Error('getYoutubeAccessToken mock not configured for this test'),
    );
    vi.mocked(fetchVideoChannel).mockRejectedValue(
      new Error('fetchVideoChannel mock not configured for this test'),
    );
    await resetTestDatabase(prisma);
  });

  interface SeedOptions {
    orgDeleted?: boolean;
    campaignStatus?: CampaignStatus;
    campaignDeleted?: boolean;
    deadline?: Date | null;
    slotStatus?: SlotStatus;
    slotDeleted?: boolean;
    callerKind?: 'owner' | 'other-creator' | 'no-creator' | 'deleted';
  }

  interface SeedResult {
    callerClerkId: string;
    slotId: string;
  }

  async function seedScenario(options: SeedOptions = {}): Promise<SeedResult> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const callerKind = options.callerKind ?? 'owner';

    const org = await prisma.organization.create({
      data: {
        name: `Submit Harden Org ${suffix}`,
        deletedAt: options.orgDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Submit Harden Campaign ${suffix}`,
        totalBudget: new Prisma.Decimal('1000.00'),
        currency: 'USD',
        status: options.campaignStatus ?? CampaignStatus.ACTIVE,
        submissionDeadline:
          options.deadline !== undefined
            ? options.deadline
            : new Date(Date.now() + 30 * 86_400_000),
        deletedAt: options.campaignDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    const ownerUser = await prisma.user.create({
      data: {
        clerkId: `clerk_owner_${suffix}`,
        email: `owner_${suffix}@test.local`,
        deletedAt: callerKind === 'deleted' ? new Date() : null,
      },
      select: { id: true, clerkId: true },
    });

    const creator = await prisma.creator.create({
      data: { userId: ownerUser.id },
      select: { id: true },
    });

    await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId: `ext_${suffix}`,
        tokenCiphertext: `v1.fake_iv.fake_tag.fake_ct_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        revokedAt: null,
      },
      select: { id: true },
    });

    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        status: options.slotStatus ?? SlotStatus.ACCEPTED,
        escrowAmount: new Prisma.Decimal('1000.00'),
        currentTier: MilestoneTier.BASELINE,
        platform: SocialPlatform.YOUTUBE,
        isShort: true,
        viewTarget: 100000,
        deletedAt: options.slotDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    let callerClerkId = ownerUser.clerkId;
    if (callerKind === 'other-creator') {
      const otherUser = await prisma.user.create({
        data: { clerkId: `clerk_other_${suffix}`, email: `other_${suffix}@test.local` },
        select: { id: true, clerkId: true },
      });
      await prisma.creator.create({ data: { userId: otherUser.id } });
      callerClerkId = otherUser.clerkId;
    } else if (callerKind === 'no-creator') {
      const noCreatorUser = await prisma.user.create({
        data: { clerkId: `clerk_nocreator_${suffix}`, email: `nocreator_${suffix}@test.local` },
        select: { id: true, clerkId: true },
      });
      callerClerkId = noCreatorUser.clerkId;
    }

    clerkAuthHolder.userId = callerClerkId;
    return { callerClerkId, slotId: slot.id };
  }

  function callSubmit(
    slotId: string,
    body: unknown = { contentUrl: DEFAULT_SUBMIT_URL },
  ): Promise<Response> {
    vi.mocked(auth).mockResolvedValue({
      userId: clerkAuthHolder.userId,
      sessionClaims: null,
    } as never);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = new Request(`http://localhost/api/campaigns/slots/${slotId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    return POST(req, { params: Promise.resolve({ slotId }) });
  }


  // =======================================================================
  // describe('submit — ownership uniformity')
  // =======================================================================

  describe('submit — ownership uniformity', () => {
    const EXPECTED_404 = { error: 'Not found' };
    const MALFORMED_IDS = ['../x', 'a b', 'x'.repeat(65)];

    it.each(MALFORMED_IDS)('malformed slotId %j -> 404 Not found', async (badId) => {
      const { slotId } = await seedScenario();
      const res = await callSubmit(badId);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotId } });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('unknown slot id -> 404 Not found', async () => {
      const { slotId } = await seedScenario();
      const res = await callSubmit('slot_does_not_exist');
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotId } });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('soft-deleted slot -> 404 Not found', async () => {
      const { slotId } = await seedScenario({ slotDeleted: true });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotId } });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it("another creator's slot (callerKind 'other-creator') -> 404 Not found, owner slot remains ACCEPTED", async () => {
      const { slotId } = await seedScenario({ callerKind: 'other-creator' });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotId } });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('caller with no creator profile -> 404 Not found', async () => {
      const { slotId } = await seedScenario({ callerKind: 'no-creator' });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body).toEqual(EXPECTED_404);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotId } });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('all five 404 denial bodies are deep-equal to each other', async () => {
      // 1. malformed id
      await seedScenario();
      const r1 = await callSubmit('../x');
      const b1 = await r1.json();

      // 2. unknown id
      const r2 = await callSubmit('slot_does_not_exist');
      const b2 = await r2.json();

      // 3. soft-deleted slot
      const s3 = await seedScenario({ slotDeleted: true });
      const r3 = await callSubmit(s3.slotId);
      const b3 = await r3.json();

      // 4. another creator's slot
      const s4 = await seedScenario({ callerKind: 'other-creator' });
      const r4 = await callSubmit(s4.slotId);
      const b4 = await r4.json();

      // 5. caller with no creator profile
      const s5 = await seedScenario({ callerKind: 'no-creator' });
      const r5 = await callSubmit(s5.slotId);
      const b5 = await r5.json();

      const bodies = [b1, b2, b3, b4, b5];
      expect(bodies).toHaveLength(5);
      for (const b of bodies) {
        expect(b).toEqual(EXPECTED_404);
        expect(b).toEqual(bodies[0]);
      }
    });
  });

  // =======================================================================
  // describe('submit — campaign guard')
  // =======================================================================

  describe('submit — campaign guard', () => {
    const NON_ACTIVE_CAMPAIGNS: CampaignStatus[] = [
      CampaignStatus.DRAFT,
      CampaignStatus.PAUSED,
      CampaignStatus.COMPLETED,
      CampaignStatus.CANCELLED,
    ];

    it.each(NON_ACTIVE_CAMPAIGNS)(
      'returns 409 CAMPAIGN_NOT_ACTIVE when campaign status is %s',
      async (status) => {
        const { slotId } = await seedScenario({ campaignStatus: status });
        const res = await callSubmit(slotId);
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body).toEqual({
          error: 'Campaign is not active',
          code: 'CAMPAIGN_NOT_ACTIVE',
        });

        const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
          where: { id: slotId },
        });
        expect(slot.status).toBe(SlotStatus.ACCEPTED);

        expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
        expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
      },
    );

    it('returns 409 CAMPAIGN_NOT_ACTIVE when campaign is soft-deleted', async () => {
      const { slotId } = await seedScenario({ campaignDeleted: true });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'Campaign is not active',
        code: 'CAMPAIGN_NOT_ACTIVE',
      });

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('returns 409 CAMPAIGN_NOT_ACTIVE when organization is soft-deleted', async () => {
      const { slotId } = await seedScenario({ orgDeleted: true });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'Campaign is not active',
        code: 'CAMPAIGN_NOT_ACTIVE',
      });

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('returns 409 SUBMISSION_DEADLINE_PASSED when deadline is in the past', async () => {
      const pastDeadline = new Date(Date.now() - 86_400_000);
      const { slotId } = await seedScenario({ deadline: pastDeadline });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'The submission deadline has passed',
        code: 'SUBMISSION_DEADLINE_PASSED',
      });

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('returns 409 SUBMISSION_DEADLINE_PASSED when deadline is null', async () => {
      const { slotId } = await seedScenario({ deadline: null });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'The submission deadline has passed',
        code: 'SUBMISSION_DEADLINE_PASSED',
      });

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('ordering: INVITED slot on inactive campaign returns status-conflict 409 without CAMPAIGN_NOT_ACTIVE code', async () => {
      const { slotId } = await seedScenario({
        slotStatus: SlotStatus.INVITED,
        campaignStatus: CampaignStatus.DRAFT,
      });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).not.toHaveProperty('code', 'CAMPAIGN_NOT_ACTIVE');

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.INVITED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // describe('submit — account state, body and concurrency')
  // =======================================================================

  describe('submit — account state, body and concurrency', () => {
    async function configureOwnershipMatch(slotId: string): Promise<void> {
      const sa = await prisma.socialAccount.findFirstOrThrow({
        where: { creator: { slots: { some: { id: slotId } } } },
        select: { externalId: true },
      });
      vi.mocked(getYoutubeAccessToken).mockResolvedValue('fake-access-token-123');
      vi.mocked(fetchVideoChannel).mockImplementation(async () => ({
        found: true as const,
        channelId: sa.externalId,
      }));
    }

    it('soft-deleted caller -> 403 Account disabled, body has no reason property, slot unchanged', async () => {
      const { slotId } = await seedScenario({ callerKind: 'deleted' });
      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body).toEqual({ error: 'Account disabled' });
      expect(body).not.toHaveProperty('reason');

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('extra key next to contentUrl -> 400, slot unchanged, no YouTube call', async () => {
      const { slotId } = await seedScenario();
      const res = await callSubmit(slotId, {
        contentUrl: DEFAULT_SUBMIT_URL,
        extraKey: 'not_allowed',
      });

      expect(res.status).toBe(400);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('contentUrl of 2049 characters -> 400, slot unchanged, no YouTube call', async () => {
      const { slotId } = await seedScenario();
      const longUrl = `https://www.youtube.com/shorts/${'a'.repeat(2049 - 31)}`;
      expect(longUrl.length).toBe(2049);
      const res = await callSubmit(slotId, { contentUrl: longUrl });

      expect(res.status).toBe(400);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchVideoChannel)).not.toHaveBeenCalled();
    });

    it('positive control: normal scenario with happy-path YouTube mock returns 200, slot is CONTENT_SUBMITTED', async () => {
      const { slotId } = await seedScenario();
      await configureOwnershipMatch(slotId);

      const res = await callSubmit(slotId);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty('status', SlotStatus.CONTENT_SUBMITTED);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
      expect(slot.submittedAt).not.toBeNull();
    });

    it('concurrency: 10 rounds of simultaneous submits produce exactly one 200 and one 409', async () => {
      const ROUNDS = 10;

      for (let round = 0; round < ROUNDS; round++) {
        vi.mocked(getYoutubeAccessToken).mockClear();
        vi.mocked(fetchVideoChannel).mockClear();

        const { slotId } = await seedScenario();
        await configureOwnershipMatch(slotId);

        const [res1, res2] = await Promise.all([
          callSubmit(slotId),
          callSubmit(slotId),
        ]);

        const statuses = [res1.status, res2.status].sort((a, b) => a - b);
        expect(statuses).toEqual([200, 409]);

        const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
          where: { id: slotId },
        });
        expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
        expect(slot.submittedAt).not.toBeNull();
      }
    });
  });
});
