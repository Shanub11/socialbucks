// apps/web/src/app/api/campaigns/slots/[slotId]/accept/route.test.ts
//
// Real-database integration tests for POST /api/campaigns/slots/[slotId]/accept.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only Clerk auth is mocked. Prisma and Postgres are real; users, creators,
// social accounts and slots are seeded directly so provisioning resolves them
// without a Clerk API call.

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

import { resetTestDatabase } from '@/test/reset-test-db';

import { POST } from './route';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — accept route tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
  code?: string;
}

const MS_PER_DAY = 86_400_000;
const FUTURE_DEADLINE = () => new Date(Date.now() + 30 * MS_PER_DAY);

describeDb('api/campaigns/slots/[slotId]/accept', () => {
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
        `[accept] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    authState.userId = null;
    await resetTestDatabase(prisma);
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function createUser(
    overrides: { email?: string; deletedAt?: Date } = {},
  ) {
    const suffix = randomUUID();
    return prisma.user.create({
      data: {
        clerkId: `clerk_test_accept_${suffix}`,
        email: overrides.email ?? `${suffix}@example.com`,
        deletedAt: overrides.deletedAt ?? null,
      },
      select: { id: true, clerkId: true, email: true },
    });
  }

  async function createOrganization(
    overrides: { deletedAt?: Date } = {},
  ) {
    const suffix = randomUUID();
    return prisma.organization.create({
      data: {
        name: `Org ${suffix}`,
        deletedAt: overrides.deletedAt ?? null,
      },
      select: { id: true },
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

  async function createCreatorFor(
    userId: string,
    overrides: { deletedAt?: Date } = {},
  ) {
    return prisma.creator.create({
      data: { userId, deletedAt: overrides.deletedAt ?? null },
      select: { id: true },
    });
  }

  async function addSocialAccount(
    creatorId: string,
    overrides: { platform?: SocialPlatform; revokedAt?: Date | null } = {},
  ) {
    return prisma.socialAccount.create({
      data: {
        creatorId,
        platform: overrides.platform ?? SocialPlatform.YOUTUBE,
        externalId: `ext_${randomUUID()}`,
        scopes: ['yt-analytics.readonly'],
        revokedAt: overrides.revokedAt ?? null,
      },
      select: { id: true },
    });
  }

  async function createCampaign(
    organizationId: string,
    overrides: {
      status?: CampaignStatus;
      deletedAt?: Date;
      submissionDeadline?: Date | null;
    } = {},
  ): Promise<string> {
    const suffix = randomUUID();
    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        title: `Campaign ${suffix}`,
        totalBudget: '100.00',
        currency: 'USD',
        status: overrides.status ?? CampaignStatus.ACTIVE,
        submissionDeadline:
          overrides.submissionDeadline === undefined
            ? FUTURE_DEADLINE()
            : overrides.submissionDeadline,
        deletedAt: overrides.deletedAt ?? null,
      },
      select: { id: true },
    });
    return campaign.id;
  }

  async function createInvitedSlot(
    campaignId: string,
    creatorId: string,
    overrides: {
      status?: SlotStatus;
      escrowAmount?: string;
      viewTarget?: number | null;
      metric?: string | null;
      inviteExpiresAt?: Date | null;
      deletedAt?: Date | null;
    } = {},
  ) {
    // ADR-0004: slot_disputed_requires_record is a CHECK, so a row inserted in
    // DISPUTED must carry a dispute record naming a real user.
    const disputeRecord =
      overrides.status === SlotStatus.DISPUTED
        ? {
            disputedAt: new Date(),
            disputeReason: 'Fixture dispute',
            disputeRaisedByUserId: (
              await prisma.creator.findUniqueOrThrow({
                where: { id: creatorId },
                select: { userId: true },
              })
            ).userId,
          }
        : {};

    return prisma.campaignCreatorSlot.create({
      data: {
        campaignId,
        creatorId,
        status: overrides.status ?? SlotStatus.INVITED,
        escrowAmount: overrides.escrowAmount ?? '40.00',
        viewTarget: overrides.viewTarget ?? 1000,
        metric: overrides.metric ?? 'engagedViews',
        invitedAt: new Date(),
        inviteExpiresAt:
          overrides.inviteExpiresAt === undefined
            ? new Date(Date.now() + 7 * MS_PER_DAY)
            : overrides.inviteExpiresAt,
        deletedAt: overrides.deletedAt ?? null,
        ...disputeRecord,
      },
      select: { id: true },
    });
  }

  /** Brand-owner caller + org + ACTIVE campaign + invited creator slot. */
  async function setupInviteScenario(options: {
    status?: SlotStatus;
    campaignStatus?: CampaignStatus;
    deletedCampaign?: boolean;
    deletedOrg?: boolean;
    deletedSlot?: boolean;
    inviteExpiresAt?: Date | null;
  } = {}) {
    const caller = await createUser();
    const org = await createOrganization(
      options.deletedOrg ? { deletedAt: new Date() } : {},
    );
    await addMembership(org.id, caller.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, {
      status: options.campaignStatus ?? CampaignStatus.ACTIVE,
      deletedAt: options.deletedCampaign ? new Date() : undefined,
    });
    const creator = await createCreatorFor(caller.id);
    await addSocialAccount(creator.id);
    const slot = await createInvitedSlot(campaignId, creator.id, {
      status: options.status,
      inviteExpiresAt: options.inviteExpiresAt,
      deletedAt: options.deletedSlot ? new Date() : undefined,
    });

    authState.userId = caller.clerkId;
    return {
      userId: caller.id,
      clerkId: caller.clerkId,
      creatorId: creator.id,
      organizationId: org.id,
      campaignId,
      slotId: slot.id,
      userEmail: caller.email,
    };
  }

  function callAccept(slotId: string, body?: unknown): Promise<Response> {
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/accept`,
      {
        method: 'POST',
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
            }),
      },
    );
    return POST(req, { params: Promise.resolve({ slotId }) });
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callAccept('slot_x');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns the identical 404 for unknown, malformed, soft-deleted, foreign and no-creator callers', async () => {
    const owner = await setupInviteScenario();
    const stranger = await createUser();
    const strangerCreator = await createCreatorFor(stranger.id);
    const strangerOrg = await createOrganization();
    await addMembership(strangerOrg.id, stranger.id, OrganizationRole.OWNER);
    const strangerCampaign = await createCampaign(strangerOrg.id);
    const strangerSlot = await createInvitedSlot(
      strangerCampaign,
      strangerCreator.id,
    );

    const noCreatorUser = await createUser();

    // Unknown, malformed and id-too-long params all produce the same 404.
    const paramResponses = [
      await callAccept('slot_does_not_exist'),
      await callAccept('../x'),
      await callAccept('a b'),
      await callAccept('x'.repeat(65)),
    ];
    for (const res of paramResponses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }

    // Soft-deleted slot -> identical 404.
    const softDeleted = await setupInviteScenario({ deletedSlot: true });
    const softDeletedRes = await callAccept(softDeleted.slotId);
    expect(softDeletedRes.status).toBe(404);
    expect(await softDeletedRes.json()).toEqual({ error: 'Not found' });

    // Another creator's live slot -> identical 404, slot unchanged.
    const foreignBefore = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: strangerSlot.id },
      select: { status: true },
    });
    const foreignRes = await callAccept(strangerSlot.id);
    expect(foreignRes.status).toBe(404);
    expect(await foreignRes.json()).toEqual({ error: 'Not found' });
    const foreignAfter = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: strangerSlot.id },
      select: { status: true },
    });
    expect(foreignAfter).toEqual(foreignBefore);

    // A user with no creator row -> identical 404.
    const savedAuth = authState.userId;
    authState.userId = noCreatorUser.clerkId;
    const noCreatorRes = await callAccept(owner.slotId);
    expect(noCreatorRes.status).toBe(404);
    expect(await noCreatorRes.json()).toEqual({ error: 'Not found' });
    authState.userId = savedAuth;
  });

  it('accepts an invite and returns the serialized slot', async () => {
    const f = await setupInviteScenario();

    const res = await callAccept(f.slotId);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      [
        'acceptedAt',
        'campaign',
        'declinedAt',
        'escrowAmount',
        'id',
        'inviteExpiresAt',
        'invitedAt',
        'metric',
        'organization',
        'status',
        'viewTarget',
      ].sort(),
    );
    expect(Object.keys(body.campaign).sort()).toEqual(
      ['description', 'id', 'submissionDeadline', 'title'].sort(),
    );
    expect(Object.keys(body.organization).sort()).toEqual(['name']);
    expect(body.campaign).not.toHaveProperty('organization');
    const serialized = JSON.stringify(body);
    for (const field of [
      'creatorId',
      'userId',
      'email',
      'clerkId',
      'organizationId',
    ]) {
      expect(serialized).not.toContain(`"${field}"`);
    }

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.ACCEPTED);
    const acceptedAt = slot.acceptedAt;
    if (acceptedAt === null) throw new Error('expected acceptedAt to be set');
    expect(acceptedAt.getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(acceptedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5000);
    expect(slot.escrowAmount.toFixed(2)).toBe('40.00');
    expect(slot.viewTarget).toBe(1000);
    expect(slot.metric).toBe('engagedViews');
  });

  it.each([
    SlotStatus.ACCEPTED,
    SlotStatus.CONTENT_SUBMITTED,
    SlotStatus.IN_PROGRESS,
    SlotStatus.COMPLETED,
    SlotStatus.DISPUTED,
    SlotStatus.CANCELLED,
    SlotStatus.DECLINED,
    SlotStatus.EXPIRED,
  ])('returns 409 SLOT_NOT_INVITED for a %s slot', async (status) => {
    const f = await setupInviteScenario({ status });

    const res = await callAccept(f.slotId);
    const body: ErrorBody = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: 'Invite is not pending',
      code: 'SLOT_NOT_INVITED',
    });
    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
      select: { status: true },
    });
    expect(slot.status).toBe(status);
  });

  it('returns 409 INVITE_EXPIRED when the expiry is in the past and when it is null', async () => {
    const past = await setupInviteScenario({
      inviteExpiresAt: new Date(Date.now() - MS_PER_DAY),
    });
    let res = await callAccept(past.slotId);
    let body: ErrorBody = await res.json();
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'The invite has expired', code: 'INVITE_EXPIRED' });

    const nullExpiry = await setupInviteScenario({
      inviteExpiresAt: null,
    });
    res = await callAccept(nullExpiry.slotId);
    body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'The invite has expired', code: 'INVITE_EXPIRED' });
  });

  it.each([
    CampaignStatus.DRAFT,
    CampaignStatus.PAUSED,
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
  ])('returns 409 CAMPAIGN_NOT_ACTIVE for a %s campaign', async (status) => {
    const f = await setupInviteScenario({ campaignStatus: status });

    const res = await callAccept(f.slotId);
    const body: ErrorBody = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'Campaign is not active', code: 'CAMPAIGN_NOT_ACTIVE' });
    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
      select: { status: true },
    });
    expect(slot.status).toBe(SlotStatus.INVITED);
  });

  it('returns 409 when the campaign is soft-deleted', async () => {
    const f = await setupInviteScenario({ deletedCampaign: true });

    const res = await callAccept(f.slotId);
    const body: ErrorBody = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'Campaign is not active', code: 'CAMPAIGN_NOT_ACTIVE' });
  });

  it('returns 409 when the organization is soft-deleted', async () => {
    const f = await setupInviteScenario({ deletedOrg: true });

    const res = await callAccept(f.slotId);
    const body: ErrorBody = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({ error: 'Campaign is not active', code: 'CAMPAIGN_NOT_ACTIVE' });
  });

  it('returns 409 SUBMISSION_DEADLINE_PASSED when the deadline is in the past', async () => {
    const f = await setupInviteScenario({
      campaignStatus: CampaignStatus.ACTIVE,
      deletedCampaign: false,
    });
    // Rewrite the campaign deadline to the past.
    await prisma.campaign.update({
      where: { id: f.campaignId },
      data: { submissionDeadline: new Date(Date.now() - MS_PER_DAY) },
    });

    const res = await callAccept(f.slotId);
    const body: ErrorBody = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: 'The submission deadline has passed',
      code: 'SUBMISSION_DEADLINE_PASSED',
    });
  });

  it('returns 409 YOUTUBE_ACCOUNT_REQUIRED when no social account exists or the only one is revoked', async () => {
    // setupInviteScenario seeds a live YouTube account, so remove it first:
    // otherwise this case would accept the invite instead of refusing it.
    const noAccount = await setupInviteScenario();
    await prisma.socialAccount.deleteMany({
      where: { creatorId: noAccount.creatorId },
    });
    const noAccountRes = await callAccept(noAccount.slotId);
    expect(noAccountRes.status).toBe(409);
    const noAccountBody = (await noAccountRes.json()) as ErrorBody;
    expect(noAccountBody).toEqual({
      error: 'Connect a YouTube account before accepting',
      code: 'YOUTUBE_ACCOUNT_REQUIRED',
    });

    // Only a revoked YouTube account: revoke the seeded live one.
    const revoked = await setupInviteScenario();
    await prisma.socialAccount.updateMany({
      where: { creatorId: revoked.creatorId },
      data: { revokedAt: new Date() },
    });
    const revokedRes = await callAccept(revoked.slotId);
    const revokedBody = (await revokedRes.json()) as ErrorBody;
    expect(revokedRes.status).toBe(409);
    expect(revokedBody).toEqual({
      error: 'Connect a YouTube account before accepting',
      code: 'YOUTUBE_ACCOUNT_REQUIRED',
    });
  });

  it('ignores the request body entirely', async () => {
    const f = await setupInviteScenario();

    const res = await callAccept(f.slotId, {
      status: 'COMPLETED',
      escrowAmount: '999.00',
      viewTarget: 1,
      creatorId: 'x',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe(SlotStatus.ACCEPTED);

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.ACCEPTED);
    expect(slot.escrowAmount.toFixed(2)).toBe('40.00');
    expect(slot.viewTarget).toBe(1000);
    expect(slot.metric).toBe('engagedViews');
  });

  it('a second accept returns 409 SLOT_NOT_INVITED and keeps the slot ACCEPTED', async () => {
    const f = await setupInviteScenario();

    const first = await callAccept(f.slotId);
    expect(first.status).toBe(200);

    const second = await callAccept(f.slotId);
    const secondBody: ErrorBody = await second.json();

    expect(second.status).toBe(409);
    expect(secondBody).toEqual({
      error: 'Invite is not pending',
      code: 'SLOT_NOT_INVITED',
    });
  });

  it('two concurrent accepts yield exactly one 200 and one 409 in each of ten fresh rounds', async () => {
    for (let round = 0; round < 10; round += 1) {
      const f = await setupInviteScenario();

      const [r1, r2] = await Promise.all([
        callAccept(f.slotId),
        callAccept(f.slotId),
      ]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: { status: true },
      });
      expect(slot.status).toBe(SlotStatus.ACCEPTED);
    }
  });

  it('accepting creates no PayoutEvent rows and changes no other slot', async () => {
    const f = await setupInviteScenario();
    const otherCreatorUser = await createUser();
    const otherCreator = await createCreatorFor(otherCreatorUser.id);
    await addSocialAccount(otherCreator.id);
    const otherCampaign = await createCampaign(f.organizationId);
    const otherSlot = await createInvitedSlot(otherCampaign, otherCreator.id, {
      escrowAmount: '25.00',
      viewTarget: 500,
    });

    const res = await callAccept(f.slotId);
    expect(res.status).toBe(200);

    expect(await prisma.payoutEvent.count()).toBe(0);

    const otherSlotAfter = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: otherSlot.id },
      select: { status: true },
    });
    expect(otherSlotAfter.status).toBe(SlotStatus.INVITED);
  });
});
