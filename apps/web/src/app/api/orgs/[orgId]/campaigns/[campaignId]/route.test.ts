// apps/web/src/app/api/orgs/[orgId]/campaigns/[campaignId]/route.test.ts
//
// Real-database integration tests for
// GET /api/orgs/[orgId]/campaigns/[campaignId].
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

import { GET } from './route';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — campaign detail route tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface SerializedCampaignBody {
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

describeDb('api/orgs/[orgId]/campaigns/[campaignId]', () => {
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
        clerkId: `clerk_test_campaign_detail_${suffix}`,
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

  async function createCampaign(
    organizationId: string,
    overrides: {
      status?: CampaignStatus;
      deletedAt?: Date;
      totalBudget?: string;
    } = {},
  ): Promise<string> {
    const suffix = randomUUID();
    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        title: `Campaign ${suffix}`,
        totalBudget: overrides.totalBudget ?? '100.00',
        status: overrides.status ?? CampaignStatus.DRAFT,
        deletedAt: overrides.deletedAt ?? null,
      },
      select: { id: true },
    });
    return campaign.id;
  }

  function callGet(orgId: string, campaignId: string): Promise<Response> {
    return GET(
      new Request(
        `http://localhost/api/orgs/${encodeURIComponent(orgId)}/campaigns/${encodeURIComponent(campaignId)}`,
      ),
      { params: Promise.resolve({ orgId, campaignId }) },
    );
  }

  async function ownedCampaign(role: OrganizationRole, totalBudget = '250.00') {
    const user = await createUser();
    const org = await createOrganization();
    await addMembership(org.id, user.id, role);
    const campaignId = await createCampaign(org.id, { totalBudget });
    return { user, org, campaignId };
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callGet('org_whatever', 'campaign_whatever');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([
    OrganizationRole.OWNER,
    OrganizationRole.ADMIN,
    OrganizationRole.MEMBER,
  ])('returns the campaign to a %s', async (role) => {
    const { user, org, campaignId } = await ownedCampaign(role);
    authState.userId = user.clerkId;

    const res = await callGet(org.id, campaignId);
    const body: SerializedCampaignBody = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(SERIALIZED_KEYS);
    expect(body.id).toBe(campaignId);
    expect(body.organizationId).toBe(org.id);
    expect(body.totalBudget).toBe('250.00');
    expect(typeof body.totalBudget).toBe('string');
    expect(body.currency).toBe('USD');
    expect(body.status).toBe(CampaignStatus.DRAFT);
    expect(body.description).toBeNull();
    expect(body.submissionDeadline).toBeNull();
    expect(body.createdAt).toEqual(expect.any(String));
    expect(body.updatedAt).toEqual(expect.any(String));
    expect(body).not.toHaveProperty('deletedAt');
  });

  it('returns an identical 404 for non-member, unknown campaign, soft-deleted campaign and soft-deleted org', async () => {
    const caller = await createUser();
    const stranger = await createUser();
    const liveOrg = await createOrganization();
    await addMembership(liveOrg.id, stranger.id, OrganizationRole.OWNER);
    const strangerCampaign = await createCampaign(liveOrg.id);

    const deletedCampaignOrg = await createOrganization();
    await addMembership(
      deletedCampaignOrg.id,
      caller.id,
      OrganizationRole.OWNER,
    );
    const deletedCampaign = await createCampaign(deletedCampaignOrg.id, {
      deletedAt: new Date(),
    });

    const deletedOrg = await createOrganization({ deletedAt: new Date() });
    await addMembership(deletedOrg.id, caller.id, OrganizationRole.OWNER);
    const campaignInDeletedOrg = await createCampaign(deletedOrg.id);

    authState.userId = caller.clerkId;

    const responses = [
      await callGet(liveOrg.id, strangerCampaign), // caller is not a member
      await callGet(deletedCampaignOrg.id, 'campaign_does_not_exist'), // unknown
      await callGet(deletedCampaignOrg.id, deletedCampaign), // soft-deleted
      await callGet(deletedOrg.id, campaignInDeletedOrg), // soft-deleted org
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

  it.each(['../x', 'a b', 'x'.repeat(65)])(
    'returns 404 for the malformed campaign id %j',
    async (campaignId) => {
      const { user, org } = await ownedCampaign(OrganizationRole.OWNER);
      authState.userId = user.clerkId;

      const res = await callGet(org.id, campaignId);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    },
  );

  it.each(['a b', 'x'.repeat(65)])(
    'returns 404 for the malformed org id %j',
    async (orgId) => {
      const { user, campaignId } = await ownedCampaign(
        OrganizationRole.OWNER,
      );
      authState.userId = user.clerkId;

      const res = await callGet(orgId, campaignId);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    },
  );

  it('returns 404 when a member of one org asks for another org’s campaign (IDOR)', async () => {
    const caller = await createUser();
    const stranger = await createUser();
    const ownOrg = await createOrganization();
    await addMembership(ownOrg.id, caller.id, OrganizationRole.OWNER);
    const foreignOrg = await createOrganization();
    await addMembership(foreignOrg.id, stranger.id, OrganizationRole.OWNER);
    const foreignCampaign = await createCampaign(foreignOrg.id);
    authState.userId = caller.clerkId;

    const res = await callGet(ownOrg.id, foreignCampaign);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the caller belongs to both orgs but uses the wrong org in the path', async () => {
    const caller = await createUser();
    const firstOrg = await createOrganization();
    await addMembership(firstOrg.id, caller.id, OrganizationRole.OWNER);
    const secondOrg = await createOrganization();
    await addMembership(secondOrg.id, caller.id, OrganizationRole.MEMBER);
    const secondCampaign = await createCampaign(secondOrg.id);
    authState.userId = caller.clerkId;

    const wrongPath = await callGet(firstOrg.id, secondCampaign);
    expect(wrongPath.status).toBe(404);
    expect(await wrongPath.json()).toEqual({ error: 'Not found' });

    // The same campaign is readable under the org it actually belongs to, so the
    // 404 above is the org scoping, not a missing row.
    const rightPath = await callGet(secondOrg.id, secondCampaign);
    expect(rightPath.status).toBe(200);
  });

  it('returns 403 for a soft-deleted caller', async () => {
    const { org, campaignId } = await ownedCampaign(OrganizationRole.OWNER);
    const deletedUser = await createUser({ deletedAt: new Date() });
    await addMembership(org.id, deletedUser.id, OrganizationRole.OWNER);
    authState.userId = deletedUser.clerkId;

    const res = await callGet(org.id, campaignId);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Account disabled' });
  });
});
