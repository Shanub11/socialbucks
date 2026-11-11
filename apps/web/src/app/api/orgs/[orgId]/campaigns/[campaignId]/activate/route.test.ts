// apps/web/src/app/api/orgs/[orgId]/campaigns/[campaignId]/activate/route.test.ts
//
// Real-database integration tests for POST
// /api/orgs/[orgId]/campaigns/[campaignId]/activate.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only Clerk is mocked. Prisma and Postgres are real; users are seeded directly
// so provisioning resolves them without a Clerk API call.

import { randomUUID } from 'node:crypto';

import {
  CampaignStatus,
  OrganizationRole,
  PrismaClient,
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
    'RUN_DB_TESTS != 1 — campaign activation tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
  code?: string;
}

interface ActivatedCampaignBody {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  status: string;
  totalBudget: string;
  currency: string;
  submissionDeadline: string | null;
  createdAt: string;
  updatedAt: string;
  fundingVerified: boolean;
}

const SERIALIZED_KEYS = [
  'createdAt',
  'currency',
  'description',
  'id',
  'organizationId',
  'status',
  'submissionDeadline',
  'title',
  'totalBudget',
  'updatedAt',
].sort();

const ACTIVATED_KEYS = [...SERIALIZED_KEYS, 'fundingVerified'].sort();

const MS_PER_DAY = 86_400_000;
const FUTURE_DEADLINE = () => new Date(Date.now() + 30 * MS_PER_DAY);

describeDb('api/orgs/[orgId]/campaigns/[campaignId]/activate', () => {
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
        `[campaigns] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
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

  async function createUser(overrides: { deletedAt?: Date } = {}) {
    const suffix = randomUUID();
    return prisma.user.create({
      data: {
        clerkId: `clerk_test_campaign_activate_${suffix}`,
        email: `${suffix}@example.com`,
        deletedAt: overrides.deletedAt ?? null,
      },
      select: { id: true, clerkId: true },
    });
  }

  async function createOrganization(overrides: { deletedAt?: Date } = {}) {
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

  async function createOrgWithMember(
    userId: string,
    role: OrganizationRole,
    overrides: { deletedAt?: Date } = {},
  ) {
    const org = await createOrganization(overrides);
    if (!overrides.deletedAt) {
      await addMembership(org.id, userId, role);
    }
    return org;
  }

  async function createCampaign(
    organizationId: string,
    overrides: {
      status?: CampaignStatus;
      deletedAt?: Date;
      totalBudget?: string;
      currency?: string;
      submissionDeadline?: Date | null;
    } = {},
  ): Promise<string> {
    const suffix = randomUUID();
    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        title: `Campaign ${suffix}`,
        totalBudget: overrides.totalBudget ?? '250.00',
        currency: overrides.currency ?? 'USD',
        status: overrides.status ?? CampaignStatus.DRAFT,
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

  async function readCampaign(id: string) {
    const row = await prisma.campaign.findUnique({
      where: { id },
      select: {
        status: true,
        totalBudget: true,
        currency: true,
        organizationId: true,
        submissionDeadline: true,
      },
    });
    if (!row) throw new Error('expected the campaign row to exist');
    return {
      status: row.status,
      totalBudget: row.totalBudget.toFixed(2),
      currency: row.currency,
      organizationId: row.organizationId,
      submissionDeadline: row.submissionDeadline,
    };
  }

  function callActivate(
    orgId: string,
    campaignId: string,
    init: RequestInit = { method: 'POST' },
  ): Promise<Response> {
    return POST(
      new Request(
        `http://localhost/api/orgs/${encodeURIComponent(orgId)}/campaigns/${encodeURIComponent(campaignId)}/activate`,
        init,
      ),
      { params: Promise.resolve({ orgId, campaignId }) },
    );
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callActivate('org_x', 'campaign_x');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  // The default helper sends a POST with no body and no content-type, so these
  // cases also prove that a bodyless activation is accepted.
  it.each([OrganizationRole.OWNER, OrganizationRole.ADMIN])(
    'activates a draft campaign for a %s',
    async (role) => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, role);
      const campaignId = await createCampaign(org.id);
      authState.userId = user.clerkId;

      const res = await callActivate(org.id, campaignId);
      const body: ActivatedCampaignBody = await res.json();

      expect(res.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(ACTIVATED_KEYS);
      expect(body.fundingVerified).toBe(false);
      expect(body.status).toBe(CampaignStatus.ACTIVE);
      expect(body.totalBudget).toBe('250.00');
      expect(typeof body.totalBudget).toBe('string');
      expect(body.organizationId).toBe(org.id);
      expect(body).not.toHaveProperty('deletedAt');

      const stored = await readCampaign(campaignId);
      expect(stored.status).toBe(CampaignStatus.ACTIVE);
      expect(stored.totalBudget).toBe('250.00');
    },
  );

  it('returns 403 for a MEMBER and leaves the campaign in draft', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.MEMBER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;

    const res = await callActivate(org.id, campaignId);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect((await readCampaign(campaignId)).status).toBe(CampaignStatus.DRAFT);
  });

  it('returns an identical 404 for non-member, unknown org, malformed org id and soft-deleted org', async () => {
    const caller = await createUser();
    const stranger = await createUser();
    const liveOrg = await createOrganization();
    await addMembership(liveOrg.id, stranger.id, OrganizationRole.OWNER);
    const strangerCampaign = await createCampaign(liveOrg.id);
    const deletedOrg = await createOrganization({ deletedAt: new Date() });
    const deletedOrgCampaign = await createCampaign(deletedOrg.id);
    authState.userId = caller.clerkId;

    const responses = [
      await callActivate(liveOrg.id, strangerCampaign),
      await callActivate('org_does_not_exist', strangerCampaign),
      await callActivate('a b', strangerCampaign),
      await callActivate(deletedOrg.id, deletedOrgCampaign),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
    }

    const bodies = await Promise.all(responses.map((res) => res.json()));
    expect(bodies[0]).toEqual({ error: 'Not found' });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[3]).toEqual(bodies[0]);
  });

  it('returns 404 for an unknown, malformed or soft-deleted campaign', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const deletedCampaign = await createCampaign(org.id, {
      deletedAt: new Date(),
    });
    authState.userId = user.clerkId;

    const responses = [
      await callActivate(org.id, 'campaign_does_not_exist'),
      await callActivate(org.id, '../x'),
      await callActivate(org.id, 'a b'),
      await callActivate(org.id, 'x'.repeat(65)),
      await callActivate(org.id, deletedCampaign),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('returns 404 and leaves another org’s campaign in draft (IDOR)', async () => {
    const caller = await createUser();
    const stranger = await createUser();
    const ownOrg = await createOrgWithMember(caller.id, OrganizationRole.OWNER);
    const foreignOrg = await createOrgWithMember(
      stranger.id,
      OrganizationRole.OWNER,
    );
    const foreignCampaign = await createCampaign(foreignOrg.id);
    authState.userId = caller.clerkId;

    const res = await callActivate(ownOrg.id, foreignCampaign);

    expect(res.status).toBe(404);
    expect((await readCampaign(foreignCampaign)).status).toBe(
      CampaignStatus.DRAFT,
    );
  });

  it('returns 404 when the caller belongs to both orgs but uses the wrong org in the path', async () => {
    const caller = await createUser();
    const firstOrg = await createOrgWithMember(caller.id, OrganizationRole.OWNER);
    const secondOrg = await createOrgWithMember(
      caller.id,
      OrganizationRole.OWNER,
    );
    const secondCampaign = await createCampaign(secondOrg.id);
    authState.userId = caller.clerkId;

    const wrongPath = await callActivate(firstOrg.id, secondCampaign);
    expect(wrongPath.status).toBe(404);
    expect((await readCampaign(secondCampaign)).status).toBe(
      CampaignStatus.DRAFT,
    );

    // The same campaign activates through the org it belongs to, so the 404
    // above is the org scoping, not a missing row.
    const rightPath = await callActivate(secondOrg.id, secondCampaign);
    expect(rightPath.status).toBe(200);
  });

  it('rejects a second activation without changing the row again', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;

    const first = await callActivate(org.id, campaignId);
    expect(first.status).toBe(200);

    const second = await callActivate(org.id, campaignId);
    const body: ErrorBody = await second.json();

    expect(second.status).toBe(409);
    expect(body).toEqual({
      error: 'Campaign is not a draft',
      code: 'CAMPAIGN_NOT_DRAFT',
    });
    expect((await readCampaign(campaignId)).status).toBe(CampaignStatus.ACTIVE);
  });

  it.each([
    CampaignStatus.PAUSED,
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
    CampaignStatus.ACTIVE,
  ])('returns 409 CAMPAIGN_NOT_DRAFT for a %s campaign', async (status) => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, { status });
    authState.userId = user.clerkId;
    const before = await readCampaign(campaignId);

    const res = await callActivate(org.id, campaignId);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Campaign is not a draft',
      code: 'CAMPAIGN_NOT_DRAFT',
    });
    expect(await readCampaign(campaignId)).toEqual(before);
  });

  it('returns 422 SUBMISSION_DEADLINE_REQUIRED when the deadline is null', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, {
      submissionDeadline: null,
    });
    authState.userId = user.clerkId;

    const res = await callActivate(org.id, campaignId);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'A submission deadline is required to activate',
      code: 'SUBMISSION_DEADLINE_REQUIRED',
    });
    expect((await readCampaign(campaignId)).status).toBe(CampaignStatus.DRAFT);
  });

  it('returns 422 SUBMISSION_DEADLINE_PASSED when the stored deadline has passed', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, {
      submissionDeadline: new Date(Date.now() - MS_PER_DAY),
    });
    authState.userId = user.clerkId;

    const res = await callActivate(org.id, campaignId);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'The submission deadline has passed',
      code: 'SUBMISSION_DEADLINE_PASSED',
    });
    expect((await readCampaign(campaignId)).status).toBe(CampaignStatus.DRAFT);
  });

  it('returns 422 UNSUPPORTED_CURRENCY when the stored currency is outside the allowlist', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, { currency: 'EUR' });
    authState.userId = user.clerkId;

    const res = await callActivate(org.id, campaignId);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Unsupported currency',
      code: 'UNSUPPORTED_CURRENCY',
    });
    expect((await readCampaign(campaignId)).status).toBe(CampaignStatus.DRAFT);
  });

  // No CHECK constraint exists on Campaign.totalBudget, so a zero budget can be
  // seeded directly to exercise the activation guard.
  it('returns 422 INVALID_BUDGET when the stored budget is zero', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, { totalBudget: '0.00' });
    authState.userId = user.clerkId;

    const res = await callActivate(org.id, campaignId);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'Budget must be greater than zero',
      code: 'INVALID_BUDGET',
    });
    expect((await readCampaign(campaignId)).status).toBe(CampaignStatus.DRAFT);
  });

  it('ignores a request body entirely', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;
    const before = await readCampaign(campaignId);

    const res = await callActivate(org.id, campaignId, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'COMPLETED',
        totalBudget: '1.00',
        organizationId: 'org_attacker',
      }),
    });
    const body: ActivatedCampaignBody = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe(CampaignStatus.ACTIVE);
    expect(body.totalBudget).toBe('250.00');
    expect(body.organizationId).toBe(org.id);

    const after = await readCampaign(campaignId);
    expect(after.status).toBe(CampaignStatus.ACTIVE);
    expect(after.totalBudget).toBe(before.totalBudget);
    expect(after.organizationId).toBe(before.organizationId);
  });

  it('allows exactly one of two concurrent activations', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;

    const [first, second] = await Promise.all([
      callActivate(org.id, campaignId),
      callActivate(org.id, campaignId),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect((await readCampaign(campaignId)).status).toBe(CampaignStatus.ACTIVE);
  });

  it('creates no slot or payout rows', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;

    const res = await callActivate(org.id, campaignId);

    expect(res.status).toBe(200);
    expect(
      await prisma.campaignCreatorSlot.count({ where: { campaignId } }),
    ).toBe(0);
    expect(await prisma.payoutEvent.count()).toBe(0);
  });

  it('leaves campaigns in another organization untouched', async () => {
    const user = await createUser();
    const stranger = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const otherOrg = await createOrgWithMember(
      stranger.id,
      OrganizationRole.OWNER,
    );
    const campaignId = await createCampaign(org.id);
    const otherCampaign = await createCampaign(otherOrg.id);
    authState.userId = user.clerkId;

    const res = await callActivate(org.id, campaignId);

    expect(res.status).toBe(200);
    expect((await readCampaign(campaignId)).status).toBe(
      CampaignStatus.ACTIVE,
    );
    expect((await readCampaign(otherCampaign)).status).toBe(
      CampaignStatus.DRAFT,
    );
  });
});
