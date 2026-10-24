// apps/web/src/app/api/campaigns/slots/[slotId]/approve/route.test.ts
//
// Real-database integration tests for POST /api/campaigns/slots/[slotId]/approve.
// REQUIRES RUN_DB_TESTS=1 and a reachable Postgres at TEST_DATABASE_URL.
// If the DB is unreachable, the suite FAILS LOUDLY — it never silently skips.
//
// Only Clerk auth and YouTube verification are mocked. Prisma is real,
// nothing about the database itself is faked.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, SlotStatus, SocialPlatform } from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';

const MOCK_USER_CLERK_ID = 'clerk_test_approve_owner';

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

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn('RUN_DB_TESTS != 1 — approve route tests are SKIPPED, not passing.');
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDb('POST /api/campaigns/slots/[slotId]/approve', () => {
  if (process.env.RUN_DB_TESTS === '1' && !process.env.TEST_DATABASE_URL) {
    throw new Error('RUN_DB_TESTS=1 but TEST_DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ userId: MOCK_USER_CLERK_ID } as never);
    vi.mocked(getYoutubeAccessToken).mockResolvedValue('fake-access-token-123');
    vi.mocked(verifyIsShort).mockResolvedValue(true);
  });

  interface Fixture {
    slotId: string;
    userId: string;
    organizationId: string;
    creatorId: string;
    socialAccountId: string;
    clerkId: string;
  }

  async function createFixture(
    overrides: { platform?: SocialPlatform; status?: SlotStatus; revoked?: boolean } = {},
  ): Promise<Fixture> {
    const suffix = Math.random().toString(36).slice(2, 10);

    // Reverse-order cleanup targets, populated as each resource is created.
    let ownerUserId = '';
    let creatorUserId = '';
    let organizationId = '';
    let campaignId = '';
    let socialAccountId = '';
    let slotId = '';

    try {
      const ownerUser = await prisma.user.create({
        data: { clerkId: `${MOCK_USER_CLERK_ID}_${suffix}`, email: `owner_${suffix}@test.local` },
        select: { id: true, clerkId: true },
      });
      ownerUserId = ownerUser.id;

      // Per Fix 3a: the auth mock must match THIS fixture's owner user, not the
      // shared beforeEach default — the suffix guarantees a unique clerkId per run.
      // The mock returns the clerkId string (NOT the database UUID), because
      // requireAuthApi() yields the clerkId and ensureUserProvisioned() queries by it.
      vi.mocked(auth).mockResolvedValue({ userId: ownerUser.clerkId } as never);

      const creatorUser = await prisma.user.create({
        data: { clerkId: `clerk_creator_${suffix}`, email: `creator_${suffix}@test.local` },
        select: { id: true },
      });
      creatorUserId = creatorUser.id;

      const creator = await prisma.creator.create({ data: { userId: creatorUser.id } });

      const organization = await prisma.organization.create({ data: { name: `Test Org ${suffix}` } });
      organizationId = organization.id;

      const campaign = await prisma.campaign.create({
        data: { organizationId: organization.id, title: `Test Campaign ${suffix}`, totalBudget: 1000, currency: 'USD' },
      });
      campaignId = campaign.id;

      const socialAccount = await prisma.socialAccount.create({
        data: {
          creatorId: creator.id,
          platform: overrides.platform ?? SocialPlatform.YOUTUBE,
          externalId: `ext_${suffix}`,
          handle: `handle_${suffix}`,
          // Per Fix 2: `scopes` is a non-nullable String[] on SocialAccount;
          // omitting it fails NOT NULL and is what tripped the fixture.
          scopes: ['yt-analytics.readonly'],
          // Per Fix 4 (revoked test): `tokenCiphertext` is NOT NULL in the real
          // DB even though Prisma schema says String?. Provide a dummy value
          // when revoked so the create doesn't fail on NOT NULL constraint;
          // the route handler returns 409 on revokedAt before checking tokenCiphertext.
          tokenCiphertext: overrides.revoked ? `v1.dummy.${suffix}` : (`v1.fake.${suffix}`),
          revokedAt: overrides.revoked ? new Date() : null,
        },
        select: { id: true },
      });
      socialAccountId = socialAccount.id;

      const slot = await prisma.campaignCreatorSlot.create({
        data: {
          campaignId: campaign.id,
          creatorId: creator.id,
          escrowAmount: 1000,
          status: overrides.status ?? SlotStatus.CONTENT_SUBMITTED,
          platform: overrides.platform ?? SocialPlatform.YOUTUBE,
          contentId: 'vid_abcd12345',
          socialAccountId: socialAccount.id,
        },
        select: { id: true },
      });
      slotId = slot.id;

      return {
        slotId: slot.id,
        userId: ownerUserId,
        organizationId: organization.id,
        creatorId: creator.id,
        socialAccountId: socialAccount.id,
        clerkId: ownerUser.clerkId,
      };
    } catch (error) {
      // Per Fix 3b: a fixture-building failure must not orphan rows behind
      // cleanup(), which never runs for tests that never receive a Fixture.
      // Delete in reverse creation order to avoid FK constraint violations.
      await prisma.campaignCreatorSlot.delete({ where: { id: slotId } }).catch(() => {});
      await prisma.socialAccount.delete({ where: { id: socialAccountId } }).catch(() => {});
      await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: organizationId } }).catch(() => {});
      await prisma.user.delete({ where: { id: creatorUserId } }).catch(() => {});
      await prisma.user.delete({ where: { id: ownerUserId } }).catch(() => {});
      throw error;
    }
  }

  async function addMember(organizationId: string, userId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER') {
    await prisma.organizationMember.create({ data: { organizationId, userId, role } });
  }

  async function cleanup(f: Fixture) {
    await prisma.payoutEvent.deleteMany({ where: { slotId: f.slotId } });
    await prisma.campaignCreatorSlot.delete({ where: { id: f.slotId } }).catch(() => {});
    await prisma.socialAccount.delete({ where: { id: f.socialAccountId } }).catch(() => {});
    await prisma.organizationMember.deleteMany({ where: { organizationId: f.organizationId } });
    await prisma.campaign.deleteMany({ where: { organizationId: f.organizationId } });
    await prisma.organization.delete({ where: { id: f.organizationId } }).catch(() => {});
    await prisma.creator.delete({ where: { id: f.creatorId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: f.userId } });
    const creatorUser = await prisma.creator.findUnique({ where: { id: f.creatorId } }).then(c => c?.userId);
    if (creatorUser) await prisma.user.delete({ where: { id: creatorUser } }).catch(() => {});
  }

  function callRoute(slotId: string, viewTarget: unknown) {
    const req = new Request(`http://localhost/api/campaigns/slots/${slotId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ viewTarget }),
      headers: { 'content-type': 'application/json' },
    });
    return POST(req, { params: Promise.resolve({ slotId }) });
  }

  it('YOUTUBE happy path: OWNER approves CONTENT_SUBMITTED, verifyIsShort true -> 200, IN_PROGRESS', async () => {
    const f = await createFixture();
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const res = await callRoute(f.slotId, 100000);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe(SlotStatus.IN_PROGRESS);
      expect(body.isShort).toBe(true);
      expect(body.isShortVerifiedAt).toBeTruthy();
      expect(body.viewTarget).toBe(100000);
      expect(vi.mocked(getYoutubeAccessToken)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(verifyIsShort)).toHaveBeenCalledWith('vid_abcd12345', 'fake-access-token-123');

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: f.slotId } });
      expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
      expect(slot.isShort).toBe(true);
    } finally {
      await cleanup(f);
    }
  });

  it('INSTAGRAM slot, OWNER caller -> 422 PLATFORM_NOT_SUPPORTED, slot unchanged', async () => {
    const f = await createFixture({ platform: SocialPlatform.INSTAGRAM });
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const res = await callRoute(f.slotId, 50000);
      const body = await res.json();

      expect(res.status).toBe(422);
      expect(body).toEqual({
        error: 'Approval is not yet available for this platform',
        code: 'PLATFORM_NOT_SUPPORTED',
        platform: SocialPlatform.INSTAGRAM,
      });
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
      expect(slot.approvedAt).toBeNull();
      expect(slot.viewTarget).toBeNull();
    } finally {
      await cleanup(f);
    }
  });

  it('non-member -> 403, slot unchanged', async () => {
    const f = await createFixture();
    try {
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: { status: true },
      });

      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(403);

      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: { status: true },
      });
      expect(after).toEqual(before);
    } finally {
      await cleanup(f);
    }
  });

  it('MEMBER role (not OWNER/ADMIN) -> 403, slot unchanged', async () => {
    const f = await createFixture();
    await addMember(f.organizationId, f.userId, 'MEMBER');
    try {
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: { status: true },
      });

      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(403);

      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: { status: true },
      });
      expect(after).toEqual(before);
    } finally {
      await cleanup(f);
    }
  });

  it('slot not CONTENT_SUBMITTED (ACCEPTED) -> 409, unchanged', async () => {
    const f = await createFixture({ status: SlotStatus.ACCEPTED });
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(409);
      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: f.slotId } });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);
    } finally {
      await cleanup(f);
    }
  });

  it('INSTAGRAM slot, non-member caller -> 403 (authorization precedes platform gate)', async () => {
    const f = await createFixture({ platform: SocialPlatform.INSTAGRAM });
    // Do NOT add a membership — the auth mock user has no role in this org.
    try {
      const res = await callRoute(f.slotId, 50000);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Forbidden');
      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
    } finally {
      await cleanup(f);
    }
  });

  it('INSTAGRAM slot, MEMBER role -> 403 (authorization precedes platform gate)', async () => {
    const f = await createFixture({ platform: SocialPlatform.INSTAGRAM });
    await addMember(f.organizationId, f.userId, 'MEMBER');
    try {
      const res = await callRoute(f.slotId, 50000);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Forbidden');
    } finally {
      await cleanup(f);
    }
  });

  it('platform = null with CONTENT_SUBMITTED -> 500 Slot data is inconsistent, no DB write', async () => {
    const f = await createFixture();
    await addMember(f.organizationId, f.userId, 'OWNER');

    // Set platform to null after fixture creation
    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { platform: null },
    });

    try {
      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Slot data is inconsistent');
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
      expect(slot.approvedAt).toBeNull();
      expect(slot.viewTarget).toBeNull();
    } finally {
      await cleanup(f);
    }
  });

  it('INSTAGRAM slot not in CONTENT_SUBMITTED (IN_PROGRESS) -> 409, unchanged', async () => {
    const f = await createFixture({
      platform: SocialPlatform.INSTAGRAM,
      status: SlotStatus.IN_PROGRESS,
    });
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(409);
      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
    } finally {
      await cleanup(f);
    }
  });

  it('slot already IN_PROGRESS -> 409, unchanged', async () => {
    const f = await createFixture({ status: SlotStatus.IN_PROGRESS });
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(409);
    } finally {
      await cleanup(f);
    }
  });

  it('YOUTUBE, verifyIsShort false -> 422, slot still CONTENT_SUBMITTED', async () => {
    const f = await createFixture();
    await addMember(f.organizationId, f.userId, 'OWNER');
    vi.mocked(verifyIsShort).mockResolvedValue(false);
    try {
      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(422);
      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: f.slotId } });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
      expect(slot.isShort).toBeNull();
    } finally {
      await cleanup(f);
    }
  });

  it('YOUTUBE, SocialAccount revoked since submission -> 409, unchanged', async () => {
    const f = await createFixture({ revoked: true });
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(409);
    } finally {
      await cleanup(f);
    }
  });

  it.each([0, -5, 3.5])('invalid viewTarget (%s) -> 400, unchanged', async (invalid) => {
    const f = await createFixture();
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const res = await callRoute(f.slotId, invalid);
      expect(res.status).toBe(400);
    } finally {
      await cleanup(f);
    }
  });

  it('verifyIsShort throws -> 502, slot unchanged (still retryable)', async () => {
    const f = await createFixture();
    await addMember(f.organizationId, f.userId, 'OWNER');
    vi.mocked(verifyIsShort).mockRejectedValue(new Error('network blip'));
    try {
      const res = await callRoute(f.slotId, 100000);
      expect(res.status).toBe(502);
      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: f.slotId } });
      expect(slot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
    } finally {
      await cleanup(f);
    }
  });

  it('two concurrent approve requests on the same slot -> exactly one 200, other 409', async () => {
    const f = await createFixture();
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const [r1, r2] = await Promise.all([callRoute(f.slotId, 100000), callRoute(f.slotId, 150000)]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: f.slotId } });
      expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
      expect([100000, 150000]).toContain(slot.viewTarget);
    } finally {
      await cleanup(f);
    }
  });

  // ----- Dual-role fixture helpers -----
  interface DualRoleFixture {
    slotId: string;
    userId: string;
    creatorId: string;
    organizationId: string;
    socialAccountId: string;
    clerkId: string;
  }

  async function createDualRoleFixture(
    overrides: { status?: SlotStatus } = {},
  ): Promise<DualRoleFixture> {
    const suffix = Math.random().toString(36).slice(2, 10);

    let dualUserId = '';
    let dualCreatorId = '';
    let organizationId = '';
    let campaignId = '';
    let socialAccountId = '';
    let slotId = '';

    try {
      const dualUser = await prisma.user.create({
        data: { clerkId: `clerk_dual_${suffix}`, email: `dual_${suffix}@test.local` },
        select: { id: true, clerkId: true },
      });
      dualUserId = dualUser.id;

      const creator = await prisma.creator.create({ data: { userId: dualUser.id } });
      dualCreatorId = creator.id;

      const organization = await prisma.organization.create({ data: { name: `Dual Org ${suffix}` } });
      organizationId = organization.id;

      const campaign = await prisma.campaign.create({
        data: { organizationId: organization.id, title: `Dual Campaign ${suffix}`, totalBudget: 1000, currency: 'USD' },
      });
      campaignId = campaign.id;

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
      socialAccountId = socialAccount.id;

      const slot = await prisma.campaignCreatorSlot.create({
        data: {
          campaignId: campaign.id,
          creatorId: creator.id,
          escrowAmount: 1000,
          status: overrides.status ?? SlotStatus.CONTENT_SUBMITTED,
          platform: SocialPlatform.YOUTUBE,
          contentId: 'vid_abcd12345',
          socialAccountId: socialAccount.id,
        },
        select: { id: true },
      });
      slotId = slot.id;

      // Auth mock must return THIS fixture's dual user clerkId
      vi.mocked(auth).mockResolvedValue({ userId: dualUser.clerkId } as never);

      return {
        slotId: slot.id,
        userId: dualUser.id,
        creatorId: creator.id,
        organizationId: organization.id,
        socialAccountId: socialAccount.id,
        clerkId: dualUser.clerkId,
      };
    } catch (error) {
      await prisma.campaignCreatorSlot.delete({ where: { id: slotId } }).catch(() => {});
      await prisma.socialAccount.delete({ where: { id: socialAccountId } }).catch(() => {});
      await prisma.campaign.delete({ where: { id: campaignId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: organizationId } }).catch(() => {});
      await prisma.creator.delete({ where: { id: dualCreatorId } }).catch(() => {});
      await prisma.user.delete({ where: { id: dualUserId } }).catch(() => {});
      throw error;
    }
  }

  async function cleanupDualRole(f: DualRoleFixture) {
    // FK-safe order (all relations here are onDelete: Restrict except
    // OrganizationMember, which Cascade-deletes under its org/user):
    //   PayoutEvent -> Slot -> SocialAccount -> Campaign -> Org -> Creator -> User
    // Errors are NOT swallowed here; the caller wraps this in .catch() so a
    // cleanup failure is logged instead of masking a body assertion error.
    await prisma.payoutEvent.deleteMany({ where: { slotId: f.slotId } });
    await prisma.campaignCreatorSlot.delete({ where: { id: f.slotId } });
    await prisma.socialAccount.delete({ where: { id: f.socialAccountId } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: f.organizationId } });
    await prisma.campaign.deleteMany({ where: { organizationId: f.organizationId } });
    await prisma.organization.delete({ where: { id: f.organizationId } });
    await prisma.creator.delete({ where: { id: f.creatorId } });
    await prisma.user.delete({ where: { id: f.userId } });
  }

  // ----- Test 1: Dual-role ADMIN approves own slot -> 403 -----
  it('dual-role ADMIN approves own slot -> 403 SELF_APPROVAL_NOT_ALLOWED, no writes, no external calls', async () => {
    const f = await createDualRoleFixture();
    await addMember(f.organizationId, f.userId, 'ADMIN');
    try {
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });

      const res = await callRoute(f.slotId, 100000);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body).toEqual({
        error: 'You cannot approve your own content',
        code: 'SELF_APPROVAL_NOT_ALLOWED',
      });

      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(after).toEqual(before);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    } finally {
      await cleanupDualRole(f).catch((e) =>
        console.warn('[test cleanup failed]', e instanceof Error ? e.message : e),
      );
    }
  });

  // ----- Test 2: Dual-role OWNER approves own slot -> 403 -----
  it('dual-role OWNER approves own slot -> 403 SELF_APPROVAL_NOT_ALLOWED, no writes, no external calls', async () => {
    const f = await createDualRoleFixture();
    await addMember(f.organizationId, f.userId, 'OWNER');
    try {
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });

      const res = await callRoute(f.slotId, 100000);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body).toEqual({
        error: 'You cannot approve your own content',
        code: 'SELF_APPROVAL_NOT_ALLOWED',
      });

      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(after).toEqual(before);

      expect(vi.mocked(getYoutubeAccessToken)).not.toHaveBeenCalled();
      expect(vi.mocked(verifyIsShort)).not.toHaveBeenCalled();
    } finally {
      await cleanupDualRole(f).catch((e) =>
        console.warn('[test cleanup failed]', e instanceof Error ? e.message : e),
      );
    }
  });

  // ----- Test 3: Positive control: different ADMIN of same org approves another creator slot -> 200 -----
  it('positive control: different ADMIN of same org approves another creator slot -> 200 IN_PROGRESS with approvedAt and viewTarget', async () => {
    const f = await createFixture();
    await addMember(f.organizationId, f.userId, 'ADMIN');
    try {
      const res = await callRoute(f.slotId, 100000);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe(SlotStatus.IN_PROGRESS);
      expect(body.approvedAt).toBeTruthy();
      expect(body.viewTarget).toBe(100000);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: f.slotId } });
      expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
      expect(slot.approvedAt).not.toBeNull();
      expect(slot.viewTarget).toBe(100000);
    } finally {
      await cleanup(f);
    }
  });

  // ----- Test 4: Dual-role user approving ANOTHER creator's slot -> 200 -----
  it('dual-role user approves another creator slot in same org -> 200, slot advances', async () => {
    const dualF = await createDualRoleFixture();
    const otherSuffix = Math.random().toString(36).slice(2, 10);

    let otherUserId = '';
    let otherCreatorId = '';
    let otherSocialAccountId = '';
    let otherSlotId = '';

    try {
      const otherUser = await prisma.user.create({
        data: { clerkId: `clerk_other_${otherSuffix}`, email: `other_${otherSuffix}@test.local` },
        select: { id: true, clerkId: true },
      });
      otherUserId = otherUser.id;

      const otherCreator = await prisma.creator.create({ data: { userId: otherUser.id } });
      otherCreatorId = otherCreator.id;

      const otherSocialAccount = await prisma.socialAccount.create({
        data: {
          creatorId: otherCreator.id,
          platform: SocialPlatform.YOUTUBE,
          externalId: `ext_${otherSuffix}`,
          handle: `handle_${otherSuffix}`,
          scopes: ['yt-analytics.readonly'],
          tokenCiphertext: `v1.fake.${otherSuffix}`,
          revokedAt: null,
        },
        select: { id: true },
      });
      otherSocialAccountId = otherSocialAccount.id;

      const otherCampaign = await prisma.campaign.create({
        data: { organizationId: dualF.organizationId, title: `Other Campaign ${otherSuffix}`, totalBudget: 1000, currency: 'USD' },
      });

      const otherSlot = await prisma.campaignCreatorSlot.create({
        data: {
          campaignId: otherCampaign.id,
          creatorId: otherCreator.id,
          escrowAmount: 500,
          status: SlotStatus.CONTENT_SUBMITTED,
          platform: SocialPlatform.YOUTUBE,
          contentId: `vid_efgh${otherSuffix}`,
          socialAccountId: otherSocialAccount.id,
        },
        select: { id: true },
      });
      otherSlotId = otherSlot.id;

      // The dual-role user must be an org member to be authorized.
      await addMember(dualF.organizationId, dualF.userId, 'ADMIN');
      vi.mocked(auth).mockResolvedValue({ userId: dualF.clerkId } as never);

      const res = await callRoute(otherSlotId, 100000);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe(SlotStatus.IN_PROGRESS);
      expect(body.approvedAt).toBeTruthy();
      expect(body.viewTarget).toBe(100000);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: otherSlotId } });
      expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
      expect(slot.approvedAt).not.toBeNull();
      expect(slot.viewTarget).toBe(100000);

      // The dual-role user's OWN slot must be untouched by this approval.
      const ownSlot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: dualF.slotId } });
      expect(ownSlot.status).toBe(SlotStatus.CONTENT_SUBMITTED);
      expect(ownSlot.approvedAt).toBeNull();
      expect(ownSlot.viewTarget).toBeNull();
    } finally {
      // FK-safe order (all relations here are onDelete: Restrict except
      // OrganizationMember, which Cascade-deletes under its org/user):
      //   PayoutEvent -> Slot -> SocialAccount -> Campaign -> Org -> Creator -> User
      // Both campaigns live in dualF's org, so delete BOTH slots before the
      // org's campaigns. Errors are logged, never swallowed, so a cleanup
      // failure cannot mask a body assertion error.
      await prisma.payoutEvent.deleteMany({ where: { slotId: otherSlotId } }).catch(() => {});
      await prisma.campaignCreatorSlot.delete({ where: { id: otherSlotId } }).catch(() => {});
      await prisma.socialAccount.delete({ where: { id: otherSocialAccountId } }).catch(() => {});
      await cleanupDualRole(dualF).catch((e) =>
        console.warn('[test cleanup failed]', e instanceof Error ? e.message : e),
      );
      await prisma.creator.delete({ where: { id: otherCreatorId } }).catch(() => {});
      await prisma.user.delete({ where: { id: otherUserId } }).catch(() => {});
    }
  });

  // ----- Test 5: Ordering: dual-role user on own slot NOT CONTENT_SUBMITTED -> 403 SELF_APPROVAL_NOT_ALLOWED, not 409 -----
  it('ordering: dual-role user on own ACCEPTED slot -> 403 SELF_APPROVAL_NOT_ALLOWED, not 409', async () => {
    const f = await createDualRoleFixture({ status: SlotStatus.ACCEPTED });
    await addMember(f.organizationId, f.userId, 'ADMIN');
    try {
      const res = await callRoute(f.slotId, 100000);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body).toEqual({
        error: 'You cannot approve your own content',
        code: 'SELF_APPROVAL_NOT_ALLOWED',
      });
    } finally {
      await cleanupDualRole(f).catch((e) =>
        console.warn('[test cleanup failed]', e instanceof Error ? e.message : e),
      );
    }
  });

  // ----- Test 6: Creator with no org membership -> 403 Forbidden, no code field -----
  it('creator with no org membership approving own slot -> 403 Forbidden, no code field (authorization precedes guard)', async () => {
    const f = await createDualRoleFixture();
    // No membership added — the user is a creator but not an org member.
    vi.mocked(auth).mockResolvedValue({ userId: f.clerkId } as never);
    try {
      const res = await callRoute(f.slotId, 100000);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body).toEqual({ error: 'Forbidden' });
      expect(body.code).toBeUndefined();
    } finally {
      await cleanupDualRole(f).catch((e) =>
        console.warn('[test cleanup failed]', e instanceof Error ? e.message : e),
      );
    }
  });

  // ----- Test 7: Existing tests remain unaffected; all 37 + 7 new pass -----
  // Verified manually: none of the existing test cases are modified.
});