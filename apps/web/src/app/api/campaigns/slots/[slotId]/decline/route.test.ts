// apps/web/src/app/api/campaigns/slots/[slotId]/decline/route.test.ts
//
// Real-database integration tests for POST /api/campaigns/slots/[slotId]/decline.
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

import { POST as acceptSlot } from '@/app/api/campaigns/slots/[slotId]/accept/route';
import { POST as createInvite } from '@/app/api/orgs/[orgId]/campaigns/[campaignId]/invites/route';

import { POST } from './route';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — decline route tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
  code?: string;
}

const MS_PER_DAY = 86_400_000;
const FUTURE_DEADLINE = () => new Date(Date.now() + 30 * MS_PER_DAY);

describeDb('api/campaigns/slots/[slotId]/decline', () => {
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
        `[decline] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
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
        clerkId: `clerk_test_decline_${suffix}`,
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

  function callDecline(slotId: string, body?: unknown): Promise<Response> {
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/decline`,
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

  function callCreateInvite(
    orgId: string,
    campaignId: string,
    body: unknown,
  ): Promise<Response> {
    return createInvite(
      new Request(
        `http://localhost/api/orgs/${orgId}/campaigns/${campaignId}/invites`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ orgId, campaignId }) },
    );
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callDecline('slot_x');

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

    const paramResponses = [
      await callDecline('slot_does_not_exist'),
      await callDecline('../x'),
      await callDecline('a b'),
      await callDecline('x'.repeat(65)),
    ];
    for (const res of paramResponses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }

    const softDeleted = await setupInviteScenario({ deletedSlot: true });
    const softDeletedRes = await callDecline(softDeleted.slotId);
    expect(softDeletedRes.status).toBe(404);
    expect(await softDeletedRes.json()).toEqual({ error: 'Not found' });

    const foreignBefore = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: strangerSlot.id },
      select: { status: true },
    });
    const foreignRes = await callDecline(strangerSlot.id);
    expect(foreignRes.status).toBe(404);
    expect(await foreignRes.json()).toEqual({ error: 'Not found' });
    const foreignAfter = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: strangerSlot.id },
      select: { status: true },
    });
    expect(foreignAfter).toEqual(foreignBefore);

    const savedAuth = authState.userId;
    authState.userId = noCreatorUser.clerkId;
    const noCreatorRes = await callDecline(owner.slotId);
    expect(noCreatorRes.status).toBe(404);
    expect(await noCreatorRes.json()).toEqual({ error: 'Not found' });
    authState.userId = savedAuth;
  });

  it('declines an invite and returns the serialized slot', async () => {
    const f = await setupInviteScenario();

    const res = await callDecline(f.slotId);
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
    expect(slot.status).toBe(SlotStatus.DECLINED);
    const declinedAt = slot.declinedAt;
    if (declinedAt === null) throw new Error('expected declinedAt to be set');
    expect(declinedAt.getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(declinedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5000);
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

    const res = await callDecline(f.slotId);
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

  it('declines when the invite is already expired', async () => {
    const f = await setupInviteScenario({
      inviteExpiresAt: new Date(Date.now() - MS_PER_DAY),
    });

    const res = await callDecline(f.slotId);
    expect(res.status).toBe(200);
    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
      select: { status: true },
    });
    expect(slot.status).toBe(SlotStatus.DECLINED);
  });

  it.each([CampaignStatus.PAUSED, CampaignStatus.CANCELLED])(
    'declines when the campaign is %s',
    async (status) => {
      const f = await setupInviteScenario({ campaignStatus: status });

      const res = await callDecline(f.slotId);
      expect(res.status).toBe(200);
    },
  );

  it('declines when the campaign is soft-deleted', async () => {
    const f = await setupInviteScenario({ deletedCampaign: true });

    const res = await callDecline(f.slotId);
    expect(res.status).toBe(200);
  });

  it('declines when the organization is soft-deleted', async () => {
    const f = await setupInviteScenario({ deletedOrg: true });

    const res = await callDecline(f.slotId);
    expect(res.status).toBe(200);
  });

  it('ignores the request body entirely', async () => {
    const f = await setupInviteScenario();

    const res = await callDecline(f.slotId, {
      status: 'COMPLETED',
      escrowAmount: '999.00',
      viewTarget: 1,
      creatorId: 'x',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe(SlotStatus.DECLINED);

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: f.slotId },
    });
    expect(slot.status).toBe(SlotStatus.DECLINED);
    expect(slot.escrowAmount.toFixed(2)).toBe('40.00');
    expect(slot.viewTarget).toBe(1000);
    expect(slot.metric).toBe('engagedViews');
  });

  it('two concurrent declines yield exactly one 200 and one 409 in each of ten fresh rounds', async () => {
    for (let round = 0; round < 10; round += 1) {
      const f = await setupInviteScenario();

      const [r1, r2] = await Promise.all([
        callDecline(f.slotId),
        callDecline(f.slotId),
      ]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: { status: true },
      });
      expect(slot.status).toBe(SlotStatus.DECLINED);
    }
  });

  it('accept vs decline simultaneously: exactly one 200 and one 409 in each of ten fresh rounds', async () => {
    for (let round = 0; round < 10; round += 1) {
      const f = await setupInviteScenario();

      const acceptReq = new Request(
        `http://localhost/api/campaigns/slots/${f.slotId}/accept`,
        { method: 'POST' },
      );
      const declineReq = new Request(
        `http://localhost/api/campaigns/slots/${f.slotId}/decline`,
        { method: 'POST' },
      );
      const [acceptRes, declineRes] = await Promise.all([
        acceptSlot(acceptReq, {
          params: Promise.resolve({ slotId: f.slotId }),
        }),
        POST(declineReq, { params: Promise.resolve({ slotId: f.slotId }) }),
      ]);

      const statuses = [acceptRes.status, declineRes.status].sort(
        (a, b) => a - b,
      );
      expect(statuses).toEqual([200, 409]);

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
        select: { status: true },
      });
      if (acceptRes.status === 200) {
        expect(slot.status).toBe(SlotStatus.ACCEPTED);
      } else {
        expect(declineRes.status).toBe(200);
        expect(slot.status).toBe(SlotStatus.DECLINED);
      }
    }
  });

  it('declining frees committed escrow for a later invite (money integration)', async () => {
    const f = await setupInviteScenario();
    // The first creator holds 60.00 of the campaign's 100.00 budget.
    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { escrowAmount: '60.00' },
    });

    const invitee = await createUser();
    const inviteeCreator = await createCreatorFor(invitee.id);
    await addSocialAccount(inviteeCreator.id);
    const inviteBody = {
      creatorEmail: invitee.email,
      escrowAmount: '50.00',
      viewTarget: 1000,
    };

    // 60.00 committed leaves 40.00, so a 50.00 invite is refused.
    const blocked = await callCreateInvite(
      f.organizationId,
      f.campaignId,
      inviteBody,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: 'Escrow exceeds the remaining campaign budget',
      code: 'BUDGET_EXCEEDED',
      remainingBudget: '40.00',
    });

    // Declining frees the whole 60.00, so the same invite now succeeds.
    const declined = await callDecline(f.slotId);
    expect(declined.status).toBe(200);

    const allowed = await callCreateInvite(
      f.organizationId,
      f.campaignId,
      inviteBody,
    );
    expect(allowed.status).toBe(201);
  });
});
