// apps/web/src/app/api/orgs/[orgId]/campaigns/[campaignId]/invites/route.test.ts
//
// Real-database integration tests for POST
// /api/orgs/[orgId]/campaigns/[campaignId]/invites.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only Clerk is faked. Prisma and Postgres are real; users, creators, social
// accounts and subscriptions are seeded directly so provisioning resolves them
// without a Clerk API call.

import { randomUUID } from 'node:crypto';

import {
  CampaignStatus,
  OrganizationRole,
  Prisma,
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

import { MAX_SLOTS_PER_CAMPAIGN } from '@/lib/invites/constants';
import { resetTestDatabase } from '@/test/reset-test-db';

import { POST } from './route';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — invite route tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
  code?: string;
  remainingBudget?: string;
}

interface SerializedInviteBody {
  id: string;
  campaignId: string;
  status: string;
  escrowAmount: string;
  viewTarget: number | null;
  metric: string | null;
  invitedAt: string;
  inviteExpiresAt: string | null;
}

const INVITE_KEYS = [
  'campaignId',
  'escrowAmount',
  'id',
  'invitedAt',
  'inviteExpiresAt',
  'metric',
  'status',
  'viewTarget',
].sort();

const NOT_ELIGIBLE_BODY = {
  error: 'Creator not found or not eligible',
  code: 'CREATOR_NOT_ELIGIBLE',
};

const MS_PER_DAY = 86_400_000;
const FUTURE_DEADLINE = () => new Date(Date.now() + 30 * MS_PER_DAY);

describeDb('api/orgs/[orgId]/campaigns/[campaignId]/invites POST', () => {
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
        `[invites] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
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

  function uniqueEmail(prefix = 'invite'): string {
    return `${prefix}_${randomUUID()}@example.com`;
  }

  async function createUser(
    overrides: { email?: string; deletedAt?: Date } = {},
  ) {
    return prisma.user.create({
      data: {
        clerkId: `clerk_test_invite_${randomUUID()}`,
        email: overrides.email ?? uniqueEmail(),
        deletedAt: overrides.deletedAt ?? null,
      },
      select: { id: true, clerkId: true, email: true },
    });
  }

  async function createOrganization(overrides: { deletedAt?: Date } = {}) {
    return prisma.organization.create({
      data: {
        name: `Org ${randomUUID()}`,
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

  async function createCampaign(
    organizationId: string,
    overrides: {
      status?: CampaignStatus;
      totalBudget?: string;
      submissionDeadline?: Date | null;
      deletedAt?: Date;
    } = {},
  ): Promise<string> {
    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        title: `Campaign ${randomUUID()}`,
        totalBudget: overrides.totalBudget ?? '100.00',
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

  /** A user + creator + live YouTube account: everything an invite needs. */
  async function createEligibleCreator(
    overrides: { email?: string } = {},
  ): Promise<{
    user: { id: string; clerkId: string; email: string };
    creatorId: string;
  }> {
    const user = await createUser({ email: overrides.email });
    const creator = await createCreatorFor(user.id);
    await addSocialAccount(creator.id);
    return { user, creatorId: creator.id };
  }

  async function seedSlot(
    campaignId: string,
    creatorId: string,
    overrides: { status?: SlotStatus; escrowAmount?: string } = {},
  ) {
    return prisma.campaignCreatorSlot.create({
      data: {
        campaignId,
        creatorId,
        status: overrides.status ?? SlotStatus.INVITED,
        escrowAmount: overrides.escrowAmount ?? '60.00',
        viewTarget: 100_000,
        metric: 'engagedViews',
        invitedAt: new Date(),
      },
      select: { id: true },
    });
  }

  async function slotCount(campaignId: string): Promise<number> {
    return prisma.campaignCreatorSlot.count({ where: { campaignId } });
  }

  /**
   * Caller (OWNER by default) + organization + campaign, with the Clerk mock
   * pointed at the caller.
   */
  async function setup(
    options: {
      role?: OrganizationRole;
      status?: CampaignStatus;
      totalBudget?: string;
      submissionDeadline?: Date | null;
    } = {},
  ) {
    const caller = await createUser();
    const org = await createOrganization();
    await addMembership(org.id, caller.id, options.role ?? OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, {
      status: options.status,
      totalBudget: options.totalBudget,
      submissionDeadline: options.submissionDeadline,
    });
    authState.userId = caller.clerkId;
    return { caller, org, campaignId };
  }

  function inviteBody(
    creatorEmail: string,
    escrowAmount = '40.00',
    viewTarget = 100_000,
  ): Record<string, unknown> {
    return { creatorEmail, escrowAmount, viewTarget };
  }

  function callInvite(
    orgId: string,
    campaignId: string,
    body: unknown,
    contentType: string | null = 'application/json',
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (contentType !== null) headers['content-type'] = contentType;
    return POST(
      new Request(
        `http://localhost/api/orgs/${encodeURIComponent(orgId)}/campaigns/${encodeURIComponent(campaignId)}/invites`,
        {
          method: 'POST',
          headers,
          body: typeof body === 'string' ? body : JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ orgId, campaignId }) },
    );
  }

  async function callJson(
    orgId: string,
    campaignId: string,
    body: unknown,
  ): Promise<{ status: number; body: ErrorBody }> {
    const res = await callInvite(orgId, campaignId, body);
    const parsed: ErrorBody = await res.json();
    return { status: res.status, body: parsed };
  }

  // ---------------------------------------------------------------------------
  // Authentication and roles
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callInvite(
      'org_x',
      'campaign_x',
      inviteBody('creator@example.com'),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([OrganizationRole.OWNER, OrganizationRole.ADMIN])(
    'creates an invite for a %s',
    async (role) => {
      const { org, campaignId } = await setup({ role });
      const creator = await createEligibleCreator();

      const res = await callInvite(
        org.id,
        campaignId,
        inviteBody(creator.user.email),
      );

      expect(res.status).toBe(201);
      expect(await slotCount(campaignId)).toBe(1);
    },
  );

  it('returns 403 for a MEMBER and creates no slot', async () => {
    const { org, campaignId } = await setup({ role: OrganizationRole.MEMBER });
    const creator = await createEligibleCreator();

    const res = await callInvite(
      org.id,
      campaignId,
      inviteBody(creator.user.email),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(await slotCount(campaignId)).toBe(0);
  });

  it('returns an identical 404 for non-member, unknown org, malformed org id and soft-deleted org', async () => {
    const caller = await createUser();
    const stranger = await createUser();
    const strangerOrg = await createOrganization();
    await addMembership(strangerOrg.id, stranger.id, OrganizationRole.OWNER);
    const strangerCampaign = await createCampaign(strangerOrg.id);
    const deletedOrg = await createOrganization({ deletedAt: new Date() });
    const deletedOrgCampaign = await createCampaign(deletedOrg.id);
    const creator = await createEligibleCreator();
    authState.userId = caller.clerkId;
    const body = inviteBody(creator.user.email);

    const responses = [
      await callInvite(strangerOrg.id, strangerCampaign, body),
      await callInvite('org_does_not_exist', strangerCampaign, body),
      await callInvite('a b', strangerCampaign, body),
      await callInvite(deletedOrg.id, deletedOrgCampaign, body),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
    }
    const bodies = await Promise.all(responses.map((res) => res.json()));
    expect(bodies[0]).toEqual({ error: 'Not found' });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[3]).toEqual(bodies[0]);
    expect(await slotCount(strangerCampaign)).toBe(0);
    expect(await slotCount(deletedOrgCampaign)).toBe(0);
  });

  it('returns 404 for an unknown, malformed or soft-deleted campaign', async () => {
    const { org } = await setup();
    const creator = await createEligibleCreator();
    const deletedCampaign = await createCampaign(org.id, {
      deletedAt: new Date(),
    });
    const body = inviteBody(creator.user.email);

    const responses = [
      await callInvite(org.id, 'campaign_does_not_exist', body),
      await callInvite(org.id, '../x', body),
      await callInvite(org.id, 'a b', body),
      await callInvite(org.id, 'x'.repeat(65), body),
      await callInvite(org.id, deletedCampaign, body),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
    expect(await slotCount(deletedCampaign)).toBe(0);
  });

  it('returns 404 for another org’s campaign and creates no slot (IDOR)', async () => {
    const { org } = await setup();
    const stranger = await createUser();
    const foreignOrg = await createOrganization();
    await addMembership(foreignOrg.id, stranger.id, OrganizationRole.OWNER);
    const foreignCampaign = await createCampaign(foreignOrg.id);
    const creator = await createEligibleCreator();

    const res = await callInvite(
      org.id,
      foreignCampaign,
      inviteBody(creator.user.email),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(await slotCount(foreignCampaign)).toBe(0);
  });

  it('returns 404 when the caller belongs to both orgs but uses the wrong org in the path', async () => {
    const { caller, org, campaignId } = await setup();
    const secondOrg = await createOrganization();
    await addMembership(secondOrg.id, caller.id, OrganizationRole.OWNER);
    const secondCampaign = await createCampaign(secondOrg.id);
    const creator = await createEligibleCreator();
    const body = inviteBody(creator.user.email);

    const wrongPath = await callInvite(org.id, secondCampaign, body);
    expect(wrongPath.status).toBe(404);
    expect(await slotCount(secondCampaign)).toBe(0);

    // The same campaign accepts an invite through its own org, so the 404 above
    // is the scoping, not a missing row.
    const rightPath = await callInvite(secondOrg.id, secondCampaign, body);
    expect(rightPath.status).toBe(201);

    // And the other campaign is still untouched by the failed attempt.
    expect(await slotCount(campaignId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Campaign state
  // ---------------------------------------------------------------------------

  it.each([
    CampaignStatus.DRAFT,
    CampaignStatus.PAUSED,
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
  ])('returns 409 CAMPAIGN_NOT_ACTIVE for a %s campaign', async (status) => {
    const { org, campaignId } = await setup({ status });
    const creator = await createEligibleCreator();

    const { status: code, body } = await callJson(
      org.id,
      campaignId,
      inviteBody(creator.user.email),
    );

    expect(code).toBe(409);
    expect(body).toEqual({
      error: 'Campaign is not active',
      code: 'CAMPAIGN_NOT_ACTIVE',
    });
    expect(await slotCount(campaignId)).toBe(0);
  });

  it('returns 409 SUBMISSION_DEADLINE_PASSED when the stored deadline has passed', async () => {
    const { org, campaignId } = await setup({
      submissionDeadline: new Date(Date.now() - MS_PER_DAY),
    });
    const creator = await createEligibleCreator();

    const { status, body } = await callJson(
      org.id,
      campaignId,
      inviteBody(creator.user.email),
    );

    expect(status).toBe(409);
    expect(body).toEqual({
      error: 'The submission deadline has passed',
      code: 'SUBMISSION_DEADLINE_PASSED',
    });
    expect(await slotCount(campaignId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('creates an INVITED slot with the submitted terms and no invitee identity', async () => {
    const { org, campaignId } = await setup();
    const creator = await createEligibleCreator();

    const res = await callInvite(
      org.id,
      campaignId,
      inviteBody(creator.user.email, '40.00', 250_000),
    );
    const body: SerializedInviteBody = await res.json();

    expect(res.status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(INVITE_KEYS);
    expect(typeof body.escrowAmount).toBe('string');
    expect(body.escrowAmount).toBe('40.00');
    expect(body.status).toBe(SlotStatus.INVITED);
    expect(body.metric).toBe('engagedViews');
    expect(body.viewTarget).toBe(250_000);
    expect(body.campaignId).toBe(campaignId);
    expect(new Date(body.invitedAt).getTime()).not.toBeNaN();
    expect(body.inviteExpiresAt).not.toBeNull();

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(creator.user.email);
    expect(serialized).not.toContain(creator.creatorId);
    expect(serialized).not.toContain(creator.user.id);
    expect(serialized).not.toContain('creatorId');
    expect(serialized).not.toContain('creatorEmail');

    const slot = await prisma.campaignCreatorSlot.findFirst({
      where: { campaignId },
      select: {
        creatorId: true,
        status: true,
        escrowAmount: true,
        viewTarget: true,
        metric: true,
        platform: true,
        socialAccountId: true,
        contentId: true,
        invitedAt: true,
        inviteExpiresAt: true,
      },
    });
    if (slot === null) throw new Error('expected the slot to exist');

    expect(slot.creatorId).toBe(creator.creatorId);
    expect(slot.status).toBe(SlotStatus.INVITED);
    expect(slot.escrowAmount.toFixed(2)).toBe('40.00');
    expect(slot.viewTarget).toBe(250_000);
    expect(slot.metric).toBe('engagedViews');
    expect(slot.platform).toBeNull();
    expect(slot.socialAccountId).toBeNull();
    expect(slot.contentId).toBeNull();
    expect(slot.invitedAt).toBeInstanceOf(Date);
    if (slot.inviteExpiresAt === null) {
      throw new Error('expected inviteExpiresAt to be set');
    }
    const ttl = slot.inviteExpiresAt.getTime() - slot.invitedAt.getTime();
    expect(Math.abs(ttl - 7 * MS_PER_DAY)).toBeLessThanOrEqual(5000);
  });

  it('matches the address case-insensitively and after trimming', async () => {
    const { org, campaignId } = await setup();
    const creator = await createEligibleCreator({
      email: 'creator.mixed@example.com',
    });

    const res = await callInvite(
      org.id,
      campaignId,
      inviteBody('  Creator.Mixed@Example.COM ', '40.00'),
    );

    expect(res.status).toBe(201);
    const slot = await prisma.campaignCreatorSlot.findFirst({
      where: { campaignId },
      select: { creatorId: true },
    });
    expect(slot?.creatorId).toBe(creator.creatorId);
  });

  // ---------------------------------------------------------------------------
  // No oracle: every ineligible cause is the same 422 body
  // ---------------------------------------------------------------------------

  interface ScenarioContext {
    orgId: string;
    campaignId: string;
    callerId: string;
    callerEmail: string;
  }

  /**
   * The address to submit, plus the seeded slot's id when the scenario seeds a
   * slot on purpose (so the test can prove the request left it alone).
   */
  interface PreparedScenario {
    email: string;
    seededSlotId?: string;
  }

  interface IneligibleScenario {
    label: string;
    prepare: (ctx: ScenarioContext) => Promise<PreparedScenario>;
  }

  async function eligibleCreatorWith(
    email?: string,
  ): Promise<{ userId: string; creatorId: string; email: string }> {
    const user = await createUser({ email });
    const creator = await createCreatorFor(user.id);
    await addSocialAccount(creator.id);
    return { userId: user.id, creatorId: creator.id, email: user.email };
  }

  const INELIGIBLE_SCENARIOS: IneligibleScenario[] = [
    {
      label: 'an unknown email',
      prepare: async () => ({ email: uniqueEmail('nobody') }),
    },
    {
      label: 'a soft-deleted user',
      prepare: async () => {
        const user = await createUser({ deletedAt: new Date() });
        const creator = await createCreatorFor(user.id);
        await addSocialAccount(creator.id);
        return { email: user.email };
      },
    },
    {
      label: 'a user with no creator row',
      prepare: async () => ({ email: (await createUser()).email }),
    },
    {
      label: 'a soft-deleted creator',
      prepare: async () => {
        const user = await createUser();
        const creator = await createCreatorFor(user.id, {
          deletedAt: new Date(),
        });
        await addSocialAccount(creator.id);
        return { email: user.email };
      },
    },
    {
      label: 'a creator with no social account',
      prepare: async () => {
        const user = await createUser();
        await createCreatorFor(user.id);
        return { email: user.email };
      },
    },
    {
      label: 'a creator whose only YouTube account is revoked',
      prepare: async () => {
        const user = await createUser();
        const creator = await createCreatorFor(user.id);
        await addSocialAccount(creator.id, { revokedAt: new Date() });
        return { email: user.email };
      },
    },
    {
      label: 'a creator with only an Instagram account',
      prepare: async () => {
        const user = await createUser();
        const creator = await createCreatorFor(user.id);
        await addSocialAccount(creator.id, {
          platform: SocialPlatform.INSTAGRAM,
        });
        return { email: user.email };
      },
    },
    {
      label: 'two users sharing the same email',
      prepare: async () => {
        const email = uniqueEmail('duplicate');
        await createUser({ email });
        const creator = await eligibleCreatorWith(email);
        return { email: creator.email };
      },
    },
    {
      label: 'a creator already invited to this campaign',
      prepare: async (ctx) => {
        const creator = await eligibleCreatorWith();
        const slot = await seedSlot(ctx.campaignId, creator.creatorId, {
          status: SlotStatus.INVITED,
          escrowAmount: '20.00',
        });
        return { email: creator.email, seededSlotId: slot.id };
      },
    },
    {
      label: 'a creator who already declined this campaign',
      prepare: async (ctx) => {
        const creator = await eligibleCreatorWith();
        const slot = await seedSlot(ctx.campaignId, creator.creatorId, {
          status: SlotStatus.DECLINED,
          escrowAmount: '20.00',
        });
        return { email: creator.email, seededSlotId: slot.id };
      },
    },
    {
      label: 'a user who is a member of the organization',
      prepare: async (ctx) => {
        const creator = await eligibleCreatorWith();
        await addMembership(ctx.orgId, creator.userId, OrganizationRole.MEMBER);
        return { email: creator.email };
      },
    },
    {
      label: 'the caller themselves',
      prepare: async (ctx) => {
        const creator = await createCreatorFor(ctx.callerId);
        await addSocialAccount(creator.id);
        return { email: ctx.callerEmail };
      },
    },
  ];

  interface SeededSlotSnapshot {
    id: string;
    status: SlotStatus;
    escrowAmount: string;
    viewTarget: number | null;
  }

  async function readSlotSnapshot(
    slotId: string,
  ): Promise<SeededSlotSnapshot> {
    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: {
        id: true,
        status: true,
        escrowAmount: true,
        viewTarget: true,
      },
    });
    return {
      id: slot.id,
      status: slot.status,
      escrowAmount: slot.escrowAmount.toFixed(2),
      viewTarget: slot.viewTarget,
    };
  }

  async function runIneligibleScenario(scenario: IneligibleScenario) {
    const { caller, org, campaignId } = await setup();
    const prepared = await scenario.prepare({
      orgId: org.id,
      campaignId,
      callerId: caller.id,
      callerEmail: caller.email,
    });
    const seededSlotId = prepared.seededSlotId;

    const slotsBefore = await slotCount(campaignId);
    const seededBefore =
      seededSlotId === undefined ? null : await readSlotSnapshot(seededSlotId);

    const res = await callInvite(
      org.id,
      campaignId,
      inviteBody(prepared.email),
    );
    const body: ErrorBody = await res.json();

    const slotsAfter = await slotCount(campaignId);
    const seededAfter =
      seededSlotId === undefined ? null : await readSlotSnapshot(seededSlotId);

    return {
      status: res.status,
      body,
      slotsBefore,
      slotsAfter,
      seededBefore,
      seededAfter,
    };
  }

  it.each(INELIGIBLE_SCENARIOS.map((scenario) => ({ ...scenario })))(
    'returns the same 422 for $label',
    async (scenario) => {
      const result = await runIneligibleScenario(scenario);

      expect(result.status).toBe(422);
      expect(result.body).toEqual(NOT_ELIGIBLE_BODY);
      // The post-condition is that this request added no slot. Scenarios that
      // seed a slot on purpose legitimately start at 1, so compare before and
      // after rather than demanding an empty campaign.
      expect(result.slotsAfter).toBe(result.slotsBefore);

      if (result.seededBefore !== null) {
        expect(result.seededAfter).not.toBeNull();
        if (result.seededAfter === null) {
          throw new Error('expected the seeded slot to survive the request');
        }
        expect(result.seededAfter.id).toBe(result.seededBefore.id);
        expect(result.seededAfter.status).toBe(result.seededBefore.status);
        expect(result.seededAfter.escrowAmount).toBe(
          result.seededBefore.escrowAmount,
        );
        expect(result.seededAfter.viewTarget).toBe(
          result.seededBefore.viewTarget,
        );
      }
    },
  );

  it('returns byte-identical bodies for every ineligible cause', async () => {
    const bodies: ErrorBody[] = [];
    for (const scenario of INELIGIBLE_SCENARIOS) {
      const result = await runIneligibleScenario(scenario);
      expect(result.status).toBe(422);
      bodies.push(result.body);
    }

    const [first, ...rest] = bodies;
    expect(first).toEqual(NOT_ELIGIBLE_BODY);
    for (const body of rest) {
      expect(body).toEqual(first);
    }
  });

  // ---------------------------------------------------------------------------
  // Budget
  // ---------------------------------------------------------------------------

  it('accepts escrow exactly equal to the remaining budget', async () => {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const creator = await createEligibleCreator();

    const res = await callInvite(
      org.id,
      campaignId,
      inviteBody(creator.user.email, '100.00'),
    );

    expect(res.status).toBe(201);
    expect(await slotCount(campaignId)).toBe(1);
  });

  it('rejects one cent over the remaining budget with a 2dp remaining amount', async () => {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const creator = await createEligibleCreator();

    const { status, body } = await callJson(
      org.id,
      campaignId,
      inviteBody(creator.user.email, '100.01'),
    );

    expect(status).toBe(409);
    expect(body).toEqual({
      error: 'Escrow exceeds the remaining campaign budget',
      code: 'BUDGET_EXCEEDED',
      remainingBudget: '100.00',
    });
    expect(await slotCount(campaignId)).toBe(0);
  });

  it('accounts for an existing INVITED slot’s committed escrow', async () => {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const existing = await createEligibleCreator();
    await seedSlot(campaignId, existing.creatorId, {
      status: SlotStatus.INVITED,
      escrowAmount: '60.00',
    });
    const creator = await createEligibleCreator();

    const over = await callJson(
      org.id,
      campaignId,
      inviteBody(creator.user.email, '40.01'),
    );
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('BUDGET_EXCEEDED');
    expect(over.body.remainingBudget).toBe('40.00');
    expect(await slotCount(campaignId)).toBe(1);

    const exact = await callInvite(
      org.id,
      campaignId,
      inviteBody(creator.user.email, '40.00'),
    );
    expect(exact.status).toBe(201);
    expect(await slotCount(campaignId)).toBe(2);
  });

  it.each([
    SlotStatus.INVITED,
    SlotStatus.ACCEPTED,
    SlotStatus.CONTENT_SUBMITTED,
    SlotStatus.IN_PROGRESS,
    SlotStatus.COMPLETED,
    SlotStatus.DISPUTED,
  ])('counts a %s slot against the budget', async (status) => {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const existing = await createEligibleCreator();
    await seedSlot(campaignId, existing.creatorId, {
      status,
      escrowAmount: '60.00',
    });
    const creator = await createEligibleCreator();

    const result = await callJson(
      org.id,
      campaignId,
      inviteBody(creator.user.email, '40.01'),
    );

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('BUDGET_EXCEEDED');
    expect(result.body.remainingBudget).toBe('40.00');
    expect(await slotCount(campaignId)).toBe(1);
  });

  it.each([
    SlotStatus.DECLINED,
    SlotStatus.EXPIRED,
    SlotStatus.CANCELLED,
  ])('does not count a %s slot against the budget', async (status) => {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const existing = await createEligibleCreator();
    await seedSlot(campaignId, existing.creatorId, {
      status,
      escrowAmount: '60.00',
    });
    const creator = await createEligibleCreator();

    const res = await callInvite(
      org.id,
      campaignId,
      inviteBody(creator.user.email, '100.00'),
    );

    expect(res.status).toBe(201);
    expect(await slotCount(campaignId)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Budget is checked before eligibility: no oracle from the budget error
  // ---------------------------------------------------------------------------

  it('reports BUDGET_EXCEEDED identically for an eligible and an ineligible address', async () => {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const eligible = await createEligibleCreator();
    const ineligibleEmail = uniqueEmail('nobody');

    const overForEligible = await callJson(
      org.id,
      campaignId,
      inviteBody(eligible.user.email, '100.01'),
    );
    const overForIneligible = await callJson(
      org.id,
      campaignId,
      inviteBody(ineligibleEmail, '100.01'),
    );

    expect(overForEligible.status).toBe(409);
    expect(overForIneligible.status).toBe(409);
    expect(overForIneligible.body).toEqual(overForEligible.body);
    expect(overForIneligible.body).toEqual({
      error: 'Escrow exceeds the remaining campaign budget',
      code: 'BUDGET_EXCEEDED',
      remainingBudget: '100.00',
    });
    expect(await slotCount(campaignId)).toBe(0);

    // In budget, the ineligible address is the only thing that fails — with the
    // generic eligibility answer, not a budget answer.
    const inBudget = await callJson(
      org.id,
      campaignId,
      inviteBody(ineligibleEmail, '100.00'),
    );
    expect(inBudget.status).toBe(422);
    expect(inBudget.body).toEqual(NOT_ELIGIBLE_BODY);
  });

  // ---------------------------------------------------------------------------
  // Concurrency: the budget invariant
  // ---------------------------------------------------------------------------

  async function runConcurrentScenario(): Promise<{
    statuses: number[];
    bodies: ErrorBody[];
    campaignId: string;
  }> {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const creators = await Promise.all(
      Array.from({ length: 5 }, () => createEligibleCreator()),
    );

    const responses = await Promise.all(
      creators.map((creator) =>
        callInvite(org.id, campaignId, inviteBody(creator.user.email, '40.00')),
      ),
    );
    const bodies: ErrorBody[] = await Promise.all(
      responses.map((res) => res.json()),
    );

    return { statuses: responses.map((res) => res.status), bodies, campaignId };
  }

  it('allows only two of five simultaneous 40.00 invites on a 100.00 campaign', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { statuses, bodies, campaignId } = await runConcurrentScenario();

      expect(statuses.filter((status) => status === 201)).toHaveLength(2);
      expect(statuses.filter((status) => status === 409)).toHaveLength(3);

      const rejected = bodies.filter(
        (body) => body.code === 'BUDGET_EXCEEDED',
      );
      expect(rejected).toHaveLength(3);

      const agg = await prisma.campaignCreatorSlot.aggregate({
        _sum: { escrowAmount: true },
        where: {
          campaignId,
          status: { notIn: [SlotStatus.DECLINED, SlotStatus.EXPIRED, SlotStatus.CANCELLED] },
        },
      });
      const committed = agg._sum.escrowAmount ?? new Prisma.Decimal(0);
      expect(committed.toFixed(2)).toBe('80.00');
      expect(committed.lte(new Prisma.Decimal('100.00'))).toBe(true);
    }
  });

  it('allows only one of two simultaneous invites to the same creator', async () => {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const creator = await createEligibleCreator();
    const body = inviteBody(creator.user.email, '40.00');

    const [first, second] = await Promise.all([
      callInvite(org.id, campaignId, body),
      callInvite(org.id, campaignId, body),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 422]);
    expect(await slotCount(campaignId)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Slot limit
  // ---------------------------------------------------------------------------

  it('returns 409 SLOT_LIMIT_REACHED at the slot cap', async () => {
    const { org, campaignId } = await setup({ totalBudget: '100.00' });
    const suffix = randomUUID().slice(0, 8);

    const seedUsers = Array.from(
      { length: MAX_SLOTS_PER_CAMPAIGN },
      (_unused, index) => ({
        clerkId: `clerk_bulk_${suffix}_${index}`,
        email: `bulk_${suffix}_${index}@example.com`,
      }),
    );
    await prisma.user.createMany({ data: seedUsers });

    const seededUsers = await prisma.user.findMany({
      where: { clerkId: { in: seedUsers.map((row) => row.clerkId) } },
      select: { id: true },
    });
    expect(seededUsers).toHaveLength(MAX_SLOTS_PER_CAMPAIGN);

    await prisma.creator.createMany({
      data: seededUsers.map((row) => ({ userId: row.id })),
    });
    const seededCreators = await prisma.creator.findMany({
      where: { userId: { in: seededUsers.map((row) => row.id) } },
      select: { id: true },
    });
    expect(seededCreators).toHaveLength(MAX_SLOTS_PER_CAMPAIGN);

    // 0.01 each leaves the budget untouched in practice; the cap is what this
    // test exercises, and it is checked before eligibility.
    await prisma.campaignCreatorSlot.createMany({
      data: seededCreators.map((row) => ({
        campaignId,
        creatorId: row.id,
        status: SlotStatus.INVITED,
        escrowAmount: '0.01',
        viewTarget: 1000,
        metric: 'engagedViews',
        invitedAt: new Date(),
      })),
    });
    expect(await slotCount(campaignId)).toBe(MAX_SLOTS_PER_CAMPAIGN);

    const creator = await createEligibleCreator();
    const result = await callJson(
      org.id,
      campaignId,
      inviteBody(creator.user.email, '5.00'),
    );

    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: 'Invite limit reached for this campaign',
      code: 'SLOT_LIMIT_REACHED',
    });
    expect(await slotCount(campaignId)).toBe(MAX_SLOTS_PER_CAMPAIGN);
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  const VALID_EMAIL = 'candidate@example.com';
  const TOO_LONG_EMAIL = `${'a'.repeat(243)}@example.com`;

  const invalidBodies: Array<{ label: string; body: Record<string, unknown> }> = [
    {
      label: 'a missing creatorEmail',
      body: { escrowAmount: '10.00', viewTarget: 1000 },
    },
    {
      label: 'a missing escrowAmount',
      body: { creatorEmail: VALID_EMAIL, viewTarget: 1000 },
    },
    {
      label: 'a missing viewTarget',
      body: { creatorEmail: VALID_EMAIL, escrowAmount: '10.00' },
    },
    {
      label: 'a JSON-number escrow',
      body: { creatorEmail: VALID_EMAIL, escrowAmount: 5, viewTarget: 1000 },
    },
    {
      label: 'a zero escrow',
      body: { creatorEmail: VALID_EMAIL, escrowAmount: '0', viewTarget: 1000 },
    },
    {
      label: 'an escrow below the slot minimum',
      body: {
        creatorEmail: VALID_EMAIL,
        escrowAmount: '4.99',
        viewTarget: 1000,
      },
    },
    {
      label: 'an escrow with three decimals',
      body: {
        creatorEmail: VALID_EMAIL,
        escrowAmount: '1.234',
        viewTarget: 1000,
      },
    },
    {
      label: 'a zero viewTarget',
      body: { creatorEmail: VALID_EMAIL, escrowAmount: '10.00', viewTarget: 0 },
    },
    {
      label: 'a viewTarget below the minimum',
      body: {
        creatorEmail: VALID_EMAIL,
        escrowAmount: '10.00',
        viewTarget: 99,
      },
    },
    {
      label: 'a viewTarget above the maximum',
      body: {
        creatorEmail: VALID_EMAIL,
        escrowAmount: '10.00',
        viewTarget: 100_000_001,
      },
    },
    {
      label: 'a fractional viewTarget',
      body: {
        creatorEmail: VALID_EMAIL,
        escrowAmount: '10.00',
        viewTarget: 1.5,
      },
    },
    {
      label: 'a numeric-string viewTarget',
      body: {
        creatorEmail: VALID_EMAIL,
        escrowAmount: '10.00',
        viewTarget: '100',
      },
    },
    {
      label: 'an invalid email',
      body: {
        creatorEmail: 'not-an-email',
        escrowAmount: '10.00',
        viewTarget: 1000,
      },
    },
    {
      label: 'an email over 254 characters',
      body: {
        creatorEmail: TOO_LONG_EMAIL,
        escrowAmount: '10.00',
        viewTarget: 1000,
      },
    },
    ...['creatorId', 'status', 'metric', 'platform', 'inviteExpiresAt', 'organizationId', 'id'].map(
      (key) => ({
        label: `the extra key ${key}`,
        body: {
          creatorEmail: VALID_EMAIL,
          escrowAmount: '10.00',
          viewTarget: 1000,
          [key]: 'value',
        },
      }),
    ),
  ];

  it.each(invalidBodies)(
    'returns 400 for $label and creates nothing',
    async (testCase) => {
      const { org, campaignId } = await setup();

      const res = await callInvite(org.id, campaignId, testCase.body);

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.error).toBe('Invalid request');
      expect(await slotCount(campaignId)).toBe(0);
    },
  );

  it('returns 415 for a non-JSON content type', async () => {
    const { org, campaignId } = await setup();
    const creator = await createEligibleCreator();

    const res = await callInvite(
      org.id,
      campaignId,
      inviteBody(creator.user.email),
      'text/plain',
    );

    expect(res.status).toBe(415);
    expect(await slotCount(campaignId)).toBe(0);
  });

  it('returns 400 for malformed JSON', async () => {
    const { org, campaignId } = await setup();

    const res = await callInvite(org.id, campaignId, '{not json');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
    expect(await slotCount(campaignId)).toBe(0);
  });
});
