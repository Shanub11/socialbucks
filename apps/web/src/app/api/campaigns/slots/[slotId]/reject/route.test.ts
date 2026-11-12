// apps/web/src/app/api/campaigns/slots/[slotId]/reject/route.test.ts
//
// Real-database integration tests for POST /api/campaigns/slots/[slotId]/reject.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL.
// If RUN_DB_TESTS=1 but the database is unreachable, the suite FAILS LOUDLY —
// it never silently skips.
//
// Only Clerk auth and the YouTube network calls are mocked. Prisma and
// Postgres are real. The real approve and submit handlers are imported so the
// reject-vs-approve race and the resubmit-after-reject loop exercise the real
// state machine.

import { randomUUID } from 'node:crypto';

import {
  CampaignStatus,
  OrganizationRole,
  PrismaClient,
  SlotStatus,
  SocialPlatform,
} from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => {
  const state: { userId: string | null } = { userId: null };
  return state;
});

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: authState.userId, sessionClaims: null })),
  clerkClient: vi.fn(),
}));

vi.mock('@/lib/youtube/get-access-token', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/youtube/get-access-token')>();
  return { ...actual, getYoutubeAccessToken: vi.fn() };
});

vi.mock('@/lib/youtube/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/analytics')>();
  return { ...actual, verifyIsShort: vi.fn() };
});

vi.mock('@/lib/youtube/video-ownership', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/youtube/video-ownership')>();
  return { ...actual, fetchVideoChannel: vi.fn() };
});

import { POST as approveSlot } from '@/app/api/campaigns/slots/[slotId]/approve/route';
import { POST as submitSlot } from '@/app/api/campaigns/slots/[slotId]/submit/route';
import { verifyIsShort } from '@/lib/youtube/analytics';
import { getYoutubeAccessToken } from '@/lib/youtube/get-access-token';
import {
  type VideoChannelResult,
  fetchVideoChannel,
} from '@/lib/youtube/video-ownership';
import { resetTestDatabase } from '@/test/reset-test-db';

import { POST } from './route';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — reject route tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
  code?: string;
}

const MS_PER_DAY = 86_400_000;
const CONTENT_ID = 'abcdefghijk';
const CONTENT_URL = `https://www.youtube.com/shorts/${CONTENT_ID}`;
const TEST_ACCESS_TOKEN = 'fake-access-token-123';

interface Fixture {
  organizationId: string;
  organizationName: string;
  campaignId: string;
  slotId: string;
  ownerUserId: string;
  ownerClerkId: string;
  adminUserId: string;
  adminClerkId: string;
  memberUserId: string;
  memberClerkId: string;
  creatorUserId: string;
  creatorClerkId: string;
  creatorEmail: string;
  creatorId: string;
  socialAccountId: string;
  externalId: string;
}

describeDb('api/campaigns/slots/[slotId]/reject', () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';

  if (process.env.RUN_DB_TESTS === '1' && testDatabaseUrl === '') {
    throw new Error('RUN_DB_TESTS=1 but TEST_DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testDatabaseUrl }),
  });

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `[reject] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    authState.userId = null;
    vi.mocked(getYoutubeAccessToken).mockResolvedValue(TEST_ACCESS_TOKEN);
    vi.mocked(verifyIsShort).mockResolvedValue(true);
    vi.mocked(fetchVideoChannel).mockImplementation(async () => {
      const result: VideoChannelResult = {
        found: true,
        channelId: `UC${'x'.repeat(22)}`,
      };
      return result;
    });
    await resetTestDatabase(prisma);
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function createUser(label: string) {
    return prisma.user.create({
      data: {
        clerkId: `clerk_test_reject_${label}_${randomUUID()}`,
        email: `${label}_${randomUUID()}@example.com`,
      },
      select: { id: true, clerkId: true, email: true },
    });
  }

  async function addMembership(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
  ) {
    return prisma.organizationMember.create({
      data: { organizationId, userId, role },
      select: { id: true },
    });
  }

  /**
   * An org with an OWNER/ADMIN/MEMBER, an ACTIVE campaign with a future
   * deadline, and a creator with a live YouTube account holding one
   * CONTENT_SUBMITTED slot. The Clerk holder is set to the requested caller
   * (OWNER by default).
   */
  async function setup(
    options: {
      callerRole?: OrganizationRole;
      campaignStatus?: CampaignStatus;
      deletedCampaign?: boolean;
      deletedOrg?: boolean;
      deletedSlot?: boolean;
      slotStatus?: SlotStatus;
    } = {},
  ): Promise<Fixture> {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: {
        name: `Reject Org ${suffix}`,
        deletedAt: options.deletedOrg ? new Date() : null,
      },
      select: { id: true, name: true },
    });

    const owner = await createUser(`owner_${suffix}`);
    const admin = await createUser(`admin_${suffix}`);
    const member = await createUser(`member_${suffix}`);
    await addMembership(org.id, owner.id, OrganizationRole.OWNER);
    await addMembership(org.id, admin.id, OrganizationRole.ADMIN);
    await addMembership(org.id, member.id, OrganizationRole.MEMBER);

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Reject Campaign ${suffix}`,
        totalBudget: '100.00',
        currency: 'USD',
        status: options.campaignStatus ?? CampaignStatus.ACTIVE,
        submissionDeadline: new Date(Date.now() + 30 * MS_PER_DAY),
        deletedAt: options.deletedCampaign ? new Date() : null,
      },
      select: { id: true },
    });

    const creatorUser = await createUser(`creator_${suffix}`);
    const creator = await prisma.creator.create({
      data: { userId: creatorUser.id },
      select: { id: true },
    });
    const externalId = `ext_${suffix}`;
    const social = await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake.${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });

    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        status: options.slotStatus ?? SlotStatus.CONTENT_SUBMITTED,
        escrowAmount: '40.00',
        viewTarget: 1000,
        metric: 'engagedViews',
        contentUrl: CONTENT_URL,
        submittedAt: new Date(),
        platform: SocialPlatform.YOUTUBE,
        contentId: CONTENT_ID,
        socialAccountId: social.id,
        acceptedAt: new Date(),
        deletedAt: options.deletedSlot ? new Date() : null,
      },
      select: { id: true },
    });

    let caller = owner;
    if (options.callerRole === OrganizationRole.ADMIN) caller = admin;
    if (options.callerRole === OrganizationRole.MEMBER) caller = member;
    authState.userId = caller.clerkId;

    return {
      organizationId: org.id,
      organizationName: org.name,
      campaignId: campaign.id,
      slotId: slot.id,
      ownerUserId: owner.id,
      ownerClerkId: owner.clerkId,
      adminUserId: admin.id,
      adminClerkId: admin.clerkId,
      memberUserId: member.id,
      memberClerkId: member.clerkId,
      creatorUserId: creatorUser.id,
      creatorClerkId: creatorUser.clerkId,
      creatorEmail: creatorUser.email,
      creatorId: creator.id,
      socialAccountId: social.id,
      externalId,
    };
  }

  /**
   * Every scalar the reject path must not touch, with the Decimal normalised
   * so two reads of the same row compare as plain JSON.
   */
  async function slotSnapshot(slotId: string) {
    const row = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: {
        status: true,
        rejectedAt: true,
        rejectionReason: true,
        approvedAt: true,
        escrowAmount: true,
        viewTarget: true,
        metric: true,
        contentUrl: true,
        submittedAt: true,
        platform: true,
        contentId: true,
        socialAccountId: true,
      },
    });
    return { ...row, escrowAmount: row.escrowAmount.toFixed(2) };
  }

  function rejectBody(reason = 'This video is not a Short') {
    return { reason };
  }

  function callReject(
    slotId: string,
    body: unknown,
    contentType: string | null = 'application/json',
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (contentType !== null) headers['content-type'] = contentType;
    return POST(
      new Request(`http://localhost/api/campaigns/slots/${slotId}/reject`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ slotId }) },
    );
  }

  function callApprove(slotId: string): Promise<Response> {
    return approveSlot(
      new Request(`http://localhost/api/campaigns/slots/${slotId}/approve`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ slotId }) },
    );
  }

  function callSubmit(slotId: string, contentUrl: string): Promise<Response> {
    return submitSlot(
      new Request(`http://localhost/api/campaigns/slots/${slotId}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentUrl }),
      }),
      { params: Promise.resolve({ slotId }) },
    );
  }

  // ---------------------------------------------------------------------------
  // Authentication and authorization
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callReject('slot_x', rejectBody());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns the identical 404 for unknown, malformed, soft-deleted slots and a soft-deleted organization', async () => {
    const f = await setup();
    const fBefore = await slotSnapshot(f.slotId);
    const body = rejectBody();

    const paramResponses = [
      await callReject('slot_does_not_exist', body),
      await callReject('../x', body),
      await callReject('a b', body),
      await callReject('x'.repeat(65), body),
    ];
    for (const res of paramResponses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }

    const softDeleted = await setup({ deletedSlot: true });
    const softDeletedBefore = await slotSnapshot(softDeleted.slotId);
    const softDeletedRes = await callReject(softDeleted.slotId, body);
    expect(softDeletedRes.status).toBe(404);
    expect(await softDeletedRes.json()).toEqual({ error: 'Not found' });
    expect(await slotSnapshot(softDeleted.slotId)).toEqual(softDeletedBefore);

    const deletedOrg = await setup({ deletedOrg: true });
    const deletedOrgRes = await callReject(deletedOrg.slotId, body);
    expect(deletedOrgRes.status).toBe(404);
    expect(await deletedOrgRes.json()).toEqual({ error: 'Not found' });

    expect(await slotSnapshot(f.slotId)).toEqual(fBefore);
  });

  it('returns the identical 404 for a non-member and a member of another org, leaving the slot unchanged', async () => {
    const f = await setup();
    const before = await slotSnapshot(f.slotId);
    const outsider = await createUser('outsider');

    authState.userId = outsider.clerkId;
    const nonMember = await callReject(f.slotId, rejectBody());
    expect(nonMember.status).toBe(404);
    expect(await nonMember.json()).toEqual({ error: 'Not found' });

    const otherOrg = await prisma.organization.create({
      data: { name: `Other Org ${randomUUID()}` },
      select: { id: true },
    });
    await addMembership(otherOrg.id, outsider.id, OrganizationRole.OWNER);

    const wrongOrg = await callReject(f.slotId, rejectBody());
    expect(wrongOrg.status).toBe(404);
    expect(await wrongOrg.json()).toEqual({ error: 'Not found' });

    expect(await slotSnapshot(f.slotId)).toEqual(before);
  });

  it('returns 403 for a MEMBER-role caller and leaves the slot unchanged', async () => {
    const f = await setup({ callerRole: OrganizationRole.MEMBER });
    const before = await slotSnapshot(f.slotId);

    const res = await callReject(f.slotId, rejectBody());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(await slotSnapshot(f.slotId)).toEqual(before);
  });

  it('blocks the slot creator, who is also an ADMIN, with 403 SELF_ACTION_NOT_ALLOWED', async () => {
    const f = await setup();
    await addMembership(
      f.organizationId,
      f.creatorUserId,
      OrganizationRole.ADMIN,
    );
    authState.userId = f.creatorClerkId;
    const before = await slotSnapshot(f.slotId);

    const res = await callReject(f.slotId, rejectBody());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You cannot reject your own content',
      code: 'SELF_ACTION_NOT_ALLOWED',
    });
    expect(await slotSnapshot(f.slotId)).toEqual(before);
  });

  it('returns the identical 404 for the slot creator who is not an org member', async () => {
    const f = await setup();
    authState.userId = f.creatorClerkId;
    const before = await slotSnapshot(f.slotId);

    const res = await callReject(f.slotId, rejectBody());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(await slotSnapshot(f.slotId)).toEqual(before);
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it.each([OrganizationRole.OWNER, OrganizationRole.ADMIN])(
    'rejects submitted content for a %s and returns only the four keys',
    async (role) => {
      const f = await setup({ callerRole: role });
      const before = await slotSnapshot(f.slotId);

      const res = await callReject(
        f.slotId,
        rejectBody('  Video is not a Short\nPlease fix  '),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(
        ['id', 'rejectedAt', 'rejectionReason', 'status'].sort(),
      );
      expect(body.id).toBe(f.slotId);
      expect(body.status).toBe(SlotStatus.ACCEPTED);
      expect(body.rejectionReason).toBe('Video is not a Short\nPlease fix');
      const rejectedAt = new Date(body.rejectedAt).getTime();
      expect(Number.isNaN(rejectedAt)).toBe(false);
      expect(rejectedAt).toBeGreaterThan(Date.now() - 5000);
      expect(rejectedAt).toBeLessThanOrEqual(Date.now() + 5000);

      const serialized = JSON.stringify(body);
      for (const field of [
        'creatorId',
        'userId',
        'email',
        'clerkId',
        'organizationId',
        'escrowAmount',
      ]) {
        expect(serialized).not.toContain(`"${field}"`);
      }

      const after = await slotSnapshot(f.slotId);
      expect(after.status).toBe(SlotStatus.ACCEPTED);
      expect(after.rejectionReason).toBe('Video is not a Short\nPlease fix');
      const storedAt = after.rejectedAt;
      if (storedAt === null) throw new Error('expected rejectedAt to be set');
      expect(storedAt.getTime()).toBeGreaterThan(Date.now() - 5000);
      expect(storedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5000);
      expect(after.escrowAmount).toBe(before.escrowAmount);
      expect(after.viewTarget).toBe(before.viewTarget);
      expect(after.metric).toBe(before.metric);
      expect(after.contentUrl).toBe(before.contentUrl);
      expect(after.submittedAt).toEqual(before.submittedAt);
      expect(after.platform).toBe(before.platform);
      expect(after.contentId).toBe(before.contentId);
      expect(after.socialAccountId).toBe(before.socialAccountId);
      expect(after.approvedAt).toBeNull();

      expect(await prisma.payoutEvent.count()).toBe(0);
    },
  );

  // ---------------------------------------------------------------------------
  // State guards
  // ---------------------------------------------------------------------------

  it.each([
    SlotStatus.INVITED,
    SlotStatus.ACCEPTED,
    SlotStatus.IN_PROGRESS,
    SlotStatus.COMPLETED,
    SlotStatus.DISPUTED,
    SlotStatus.CANCELLED,
    SlotStatus.DECLINED,
    SlotStatus.EXPIRED,
  ])(
    'returns 409 SLOT_NOT_SUBMITTED for a %s slot without revealing its status',
    async (status) => {
      const f = await setup({ slotStatus: status });
      const before = await slotSnapshot(f.slotId);

      const res = await callReject(f.slotId, rejectBody());
      const body: ErrorBody = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'Content has not been submitted for review',
        code: 'SLOT_NOT_SUBMITTED',
      });
      expect(JSON.stringify(body)).not.toContain(status);
      expect(await slotSnapshot(f.slotId)).toEqual(before);
    },
  );

  it.each([
    CampaignStatus.DRAFT,
    CampaignStatus.PAUSED,
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
  ])(
    'returns 409 CAMPAIGN_NOT_ACTIVE for a %s campaign',
    async (status) => {
      const f = await setup({ campaignStatus: status });
      const before = await slotSnapshot(f.slotId);

      const res = await callReject(f.slotId, rejectBody());
      const body: ErrorBody = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'Campaign is not active',
        code: 'CAMPAIGN_NOT_ACTIVE',
      });
      expect(await slotSnapshot(f.slotId)).toEqual(before);
    },
  );

  it('returns 409 CAMPAIGN_NOT_ACTIVE for a soft-deleted campaign', async () => {
    const f = await setup({ deletedCampaign: true });
    const before = await slotSnapshot(f.slotId);

    const res = await callReject(f.slotId, rejectBody());
    const body: ErrorBody = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: 'Campaign is not active',
      code: 'CAMPAIGN_NOT_ACTIVE',
    });
    expect(await slotSnapshot(f.slotId)).toEqual(before);
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const invalidBodies: Array<{
    label: string;
    body: Record<string, unknown>;
  }> = [
    { label: 'a missing reason', body: {} },
    { label: 'an empty reason', body: { reason: '' } },
    { label: 'a whitespace-only reason', body: { reason: '   \n\t ' } },
    {
      label: 'a reason over the maximum length',
      body: { reason: 'a'.repeat(1001) },
    },
    {
      label: 'a reason with a NUL control character',
      body: { reason: 'bad\u0000reason' },
    },
    {
      label: 'a reason with a bidi override',
      body: { reason: 'bad\u202Ereason' },
    },
    { label: 'a numeric reason', body: { reason: 5 } },
    ...['status', 'rejectedAt', 'rejectionReason', 'viewTarget', 'creatorId'].map(
      (key) => ({
        label: `the extra key ${key}`,
        body: { reason: 'Not a Short', [key]: 'value' },
      }),
    ),
  ];

  it.each(invalidBodies)(
    'returns 400 for $label and leaves the slot unchanged',
    async (testCase) => {
      const f = await setup();
      const before = await slotSnapshot(f.slotId);

      const res = await callReject(f.slotId, testCase.body);

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Invalid request');
      expect(await slotSnapshot(f.slotId)).toEqual(before);
    },
  );

  it('accepts exactly the maximum reason length', async () => {
    const f = await setup();
    const reason = 'a'.repeat(1000);

    const res = await callReject(f.slotId, { reason });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rejectionReason).toBe(reason);
  });

  it('returns 415 for a non-JSON content type', async () => {
    const f = await setup();
    const before = await slotSnapshot(f.slotId);

    const res = await callReject(f.slotId, rejectBody(), 'text/plain');

    expect(res.status).toBe(415);
    expect(await slotSnapshot(f.slotId)).toEqual(before);
  });

  it('returns 400 for malformed JSON', async () => {
    const f = await setup();
    const before = await slotSnapshot(f.slotId);

    const res = await callReject(f.slotId, '{not json');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
    expect(await slotSnapshot(f.slotId)).toEqual(before);
  });

  it('never parses the body before authorization: a non-member gets 404 for an invalid body', async () => {
    const f = await setup();
    const outsider = await createUser('outsider_body');
    authState.userId = outsider.clerkId;

    const res = await callReject(f.slotId, '{not json');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('never parses the body before authorization: a MEMBER gets 403 for an invalid body', async () => {
    const f = await setup({ callerRole: OrganizationRole.MEMBER });

    const res = await callReject(f.slotId, '{not json');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  // ---------------------------------------------------------------------------
  // Concurrency: each scenario repeats on ten fresh slots
  // ---------------------------------------------------------------------------

  it('two simultaneous rejects yield exactly one 200 and one 409 in each of ten fresh rounds', async () => {
    for (let round = 0; round < 10; round += 1) {
      const f = await setup();

      const [r1, r2] = await Promise.all([
        callReject(f.slotId, rejectBody('spam')),
        callReject(f.slotId, rejectBody('spam')),
      ]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const row = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: {
          status: true,
          rejectedAt: true,
          rejectionReason: true,
        },
      });
      expect(row.status).toBe(SlotStatus.ACCEPTED);
      const rejectedAt = row.rejectedAt;
      if (rejectedAt === null) throw new Error('expected rejectedAt to be set');
      expect(rejectedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5000);
      expect(row.rejectionReason).toBe('spam');
    }
  });

  it('reject vs approve simultaneously: exactly one 200 and one 409 in each of ten fresh rounds', async () => {
    for (let round = 0; round < 10; round += 1) {
      const f = await setup();

      const [rejectRes, approveRes] = await Promise.all([
        callReject(f.slotId, rejectBody('spam')),
        callApprove(f.slotId),
      ]);

      const statuses = [rejectRes.status, approveRes.status].sort(
        (a, b) => a - b,
      );
      expect(statuses).toEqual([200, 409]);

      const row = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: { status: true, rejectionReason: true, approvedAt: true },
      });

      if (approveRes.status === 200) {
        expect(row.status).toBe(SlotStatus.IN_PROGRESS);
        expect(row.rejectionReason).toBeNull();
      } else {
        expect(rejectRes.status).toBe(200);
        expect(row.status).toBe(SlotStatus.ACCEPTED);
        expect(row.approvedAt).toBeNull();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Loop closure: a rejected slot can be submitted again
  // ---------------------------------------------------------------------------

  it('a rejected slot can be submitted again through the real submit route', async () => {
    const f = await setup();

    const rejected = await callReject(
      f.slotId,
      rejectBody('Please upload a different video'),
    );
    expect(rejected.status).toBe(200);

    authState.userId = f.creatorClerkId;
    vi.mocked(getYoutubeAccessToken).mockResolvedValue(TEST_ACCESS_TOKEN);
    vi.mocked(fetchVideoChannel).mockImplementation(async () => {
      const result: VideoChannelResult = {
        found: true,
        channelId: f.externalId,
      };
      return result;
    });

    const res = await callSubmit(f.slotId, CONTENT_URL);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe(SlotStatus.CONTENT_SUBMITTED);

    const row = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
      select: { status: true, submittedAt: true },
    });
    expect(row.status).toBe(SlotStatus.CONTENT_SUBMITTED);
    expect(row.submittedAt).not.toBeNull();
  });
});
