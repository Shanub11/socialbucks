// apps/web/src/app/api/orgs/[orgId]/campaigns/[campaignId]/route.patch.test.ts
//
// Real-database integration tests for PATCH
// /api/orgs/[orgId]/campaigns/[campaignId].
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

import { PATCH } from './route';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — campaign PATCH tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
  code?: string;
}

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

const INVALID_BODIES: Array<{ label: string; body: Record<string, unknown> }> = [
  { label: 'an empty body', body: {} },
  { label: 'a status key', body: { status: 'ACTIVE' } },
  { label: 'an organizationId key', body: { organizationId: 'org_other' } },
  { label: 'an id key', body: { id: 'campaign_other' } },
  { label: 'a deletedAt key', body: { deletedAt: '2026-01-01T00:00:00Z' } },
  { label: 'a JSON-number budget', body: { totalBudget: 100 } },
  { label: 'a zero budget', body: { totalBudget: '0' } },
  { label: 'a sub-cent budget', body: { totalBudget: '1.234' } },
  { label: 'an unsupported currency', body: { currency: 'EUR' } },
  { label: 'an empty title', body: { title: '' } },
  { label: 'a null title', body: { title: null } },
  {
    label: 'a past deadline',
    body: { submissionDeadline: '2020-01-01T00:00:00Z' },
  },
];

describeDb('api/orgs/[orgId]/campaigns/[campaignId] PATCH', () => {
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
        clerkId: `clerk_test_campaign_patch_${suffix}`,
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
      description?: string | null;
      submissionDeadline?: Date | null;
      updatedAt?: Date;
    } = {},
  ): Promise<string> {
    const suffix = randomUUID();
    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        title: `Campaign ${suffix}`,
        description: overrides.description ?? null,
        totalBudget: overrides.totalBudget ?? '100.00',
        currency: overrides.currency ?? 'USD',
        status: overrides.status ?? CampaignStatus.DRAFT,
        submissionDeadline: overrides.submissionDeadline ?? null,
        deletedAt: overrides.deletedAt ?? null,
        ...(overrides.updatedAt !== undefined
          ? { updatedAt: overrides.updatedAt }
          : {}),
      },
      select: { id: true },
    });
    return campaign.id;
  }

  async function snapshot(id: string) {
    const row = await prisma.campaign.findUnique({
      where: { id },
      select: {
        title: true,
        description: true,
        totalBudget: true,
        currency: true,
        submissionDeadline: true,
        status: true,
        organizationId: true,
        deletedAt: true,
        updatedAt: true,
      },
    });
    if (!row) throw new Error('expected the campaign row to exist');
    return {
      title: row.title,
      description: row.description,
      totalBudget: row.totalBudget.toFixed(2),
      currency: row.currency,
      submissionDeadline: row.submissionDeadline,
      status: row.status,
      organizationId: row.organizationId,
      deletedAt: row.deletedAt,
      updatedAt: row.updatedAt,
    };
  }

  function callPatch(
    orgId: string,
    campaignId: string,
    body: string,
    contentType: string | null = 'application/json',
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (contentType !== null) headers['content-type'] = contentType;
    return PATCH(
      new Request(
        `http://localhost/api/orgs/${encodeURIComponent(orgId)}/campaigns/${encodeURIComponent(campaignId)}`,
        { method: 'PATCH', headers, body },
      ),
      { params: Promise.resolve({ orgId, campaignId }) },
    );
  }

  async function seedSlot(campaignId: string) {
    const user = await prisma.user.create({
      data: {
        clerkId: `clerk_test_slot_creator_${randomUUID()}`,
        email: `slot_${randomUUID()}@example.com`,
      },
      select: { id: true },
    });
    const creator = await prisma.creator.create({
      data: { userId: user.id },
      select: { id: true },
    });
    return prisma.campaignCreatorSlot.create({
      data: {
        campaignId,
        creatorId: creator.id,
        escrowAmount: '100.00',
      },
      select: { id: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callPatch('org_x', 'campaign_x', JSON.stringify({ title: 'X' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([OrganizationRole.OWNER, OrganizationRole.ADMIN])(
    'updates only the supplied field for a %s',
    async (role) => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, role);
      const campaignId = await createCampaign(org.id, {
        description: 'Original description',
        totalBudget: '100.00',
        currency: 'USD',
        submissionDeadline: new Date(Date.now() + 30 * 86_400_000),
        updatedAt: new Date('2020-06-01T00:00:00.000Z'),
      });
      authState.userId = user.clerkId;
      const before = await snapshot(campaignId);

      const res = await callPatch(
        org.id,
        campaignId,
        JSON.stringify({ title: '  Renamed Campaign  ' }),
      );
      const body: SerializedCampaignBody = await res.json();

      expect(res.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(SERIALIZED_KEYS);
      expect(body.title).toBe('Renamed Campaign');
      expect(body).not.toHaveProperty('deletedAt');

      const after = await snapshot(campaignId);
      expect(after.title).toBe('Renamed Campaign');
      expect({ ...after, title: before.title, updatedAt: before.updatedAt }).toEqual(
        before,
      );
      expect(after.status).toBe(CampaignStatus.DRAFT);
      expect(after.updatedAt.getTime()).toBeGreaterThan(
        before.updatedAt.getTime(),
      );
    },
  );

  it('returns 403 for a MEMBER and leaves the row unchanged', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.MEMBER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;
    const before = await snapshot(campaignId);

    const res = await callPatch(
      org.id,
      campaignId,
      JSON.stringify({ title: 'Renamed' }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(await snapshot(campaignId)).toEqual(before);
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

    const each = JSON.stringify({ title: 'Renamed' });
    const responses = [
      await callPatch(liveOrg.id, strangerCampaign, each),
      await callPatch('org_does_not_exist', strangerCampaign, each),
      await callPatch('a b', strangerCampaign, each),
      await callPatch(deletedOrg.id, deletedOrgCampaign, each),
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
    const each = JSON.stringify({ title: 'Renamed' });

    const responses = [
      await callPatch(org.id, 'campaign_does_not_exist', each),
      await callPatch(org.id, '../x', each),
      await callPatch(org.id, 'a b', each),
      await callPatch(org.id, 'x'.repeat(65), each),
      await callPatch(org.id, deletedCampaign, each),
    ];

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('returns 404 and leaves another org’s campaign unchanged (IDOR)', async () => {
    const caller = await createUser();
    const stranger = await createUser();
    const ownOrg = await createOrgWithMember(caller.id, OrganizationRole.OWNER);
    const foreignOrg = await createOrgWithMember(
      stranger.id,
      OrganizationRole.OWNER,
    );
    const foreignCampaign = await createCampaign(foreignOrg.id);
    authState.userId = caller.clerkId;
    const before = await snapshot(foreignCampaign);

    const res = await callPatch(
      ownOrg.id,
      foreignCampaign,
      JSON.stringify({ title: 'Hijacked' }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(await snapshot(foreignCampaign)).toEqual(before);
  });

  it('returns 404 when the caller belongs to both orgs but uses the wrong org in the path', async () => {
    const caller = await createUser();
    const firstOrg = await createOrgWithMember(caller.id, OrganizationRole.OWNER);
    const secondOrg = await createOrgWithMember(
      caller.id,
      OrganizationRole.MEMBER,
    );
    const secondCampaign = await createCampaign(secondOrg.id);
    authState.userId = caller.clerkId;
    const before = await snapshot(secondCampaign);

    const res = await callPatch(
      firstOrg.id,
      secondCampaign,
      JSON.stringify({ title: 'Wrong path' }),
    );

    expect(res.status).toBe(404);
    expect(await snapshot(secondCampaign)).toEqual(before);

    // The same campaign is editable through the org it belongs to, so the 404
    // above is the org scoping, not a missing row.
    const rightPath = await callPatch(
      secondOrg.id,
      secondCampaign,
      JSON.stringify({ title: 'Right path' }),
    );
    expect(rightPath.status).toBe(403); // caller is only a MEMBER of secondOrg
  });

  it.each([
    CampaignStatus.ACTIVE,
    CampaignStatus.PAUSED,
    CampaignStatus.COMPLETED,
    CampaignStatus.CANCELLED,
  ])('returns 409 CAMPAIGN_NOT_DRAFT for a %s campaign', async (status) => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, { status });
    authState.userId = user.clerkId;
    const before = await snapshot(campaignId);

    const res = await callPatch(
      org.id,
      campaignId,
      JSON.stringify({ title: 'Renamed' }),
    );
    const body: ErrorBody = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: 'Only draft campaigns can be edited',
      code: 'CAMPAIGN_NOT_DRAFT',
    });
    expect(await snapshot(campaignId)).toEqual(before);
  });

  it.each(INVALID_BODIES)(
    'returns 400 for $label and leaves the row unchanged',
    async (testCase) => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      const campaignId = await createCampaign(org.id);
      authState.userId = user.clerkId;
      const before = await snapshot(campaignId);

      const res = await callPatch(
        org.id,
        campaignId,
        JSON.stringify(testCase.body),
      );
      const body: ErrorBody = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('Invalid request');
      expect(await snapshot(campaignId)).toEqual(before);
    },
  );

  it('clears the description when it is sent as null', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, {
      description: 'Original description',
    });
    authState.userId = user.clerkId;

    const res = await callPatch(
      org.id,
      campaignId,
      JSON.stringify({ description: null }),
    );
    const body: SerializedCampaignBody = await res.json();

    expect(res.status).toBe(200);
    expect(body.description).toBeNull();
    const after = await snapshot(campaignId);
    expect(after.description).toBeNull();
  });

  it('clears the submission deadline when it is sent as null', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id, {
      submissionDeadline: new Date(Date.now() + 30 * 86_400_000),
    });
    authState.userId = user.clerkId;

    const res = await callPatch(
      org.id,
      campaignId,
      JSON.stringify({ submissionDeadline: null }),
    );
    const body: SerializedCampaignBody = await res.json();

    expect(res.status).toBe(200);
    expect(body.submissionDeadline).toBeNull();
    const after = await snapshot(campaignId);
    expect(after.submissionDeadline).toBeNull();
  });

  it('stores a one-decimal budget as 1234.50 and returns it as a 2dp string', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;

    const res = await callPatch(
      org.id,
      campaignId,
      JSON.stringify({ totalBudget: '1234.5' }),
    );
    const body: SerializedCampaignBody = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalBudget).toBe('1234.50');
    expect(typeof body.totalBudget).toBe('string');
    const after = await snapshot(campaignId);
    expect(after.totalBudget).toBe('1234.50');
  });

  it('round-trips the largest allowed budget to the cent', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;

    const res = await callPatch(
      org.id,
      campaignId,
      JSON.stringify({ totalBudget: '9999999999.99' }),
    );
    const body: SerializedCampaignBody = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalBudget).toBe('9999999999.99');
    expect((await snapshot(campaignId)).totalBudget).toBe('9999999999.99');
  });

  it.each([
    { label: 'total budget', body: { totalBudget: '500.00' } },
    { label: 'currency', body: { currency: 'USD' } },
  ])(
    'returns 409 CAMPAIGN_HAS_SLOTS when changing the $label while a slot exists',
    async (testCase) => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      const campaignId = await createCampaign(org.id);
      await seedSlot(campaignId);
      authState.userId = user.clerkId;
      const before = await snapshot(campaignId);

      const res = await callPatch(
        org.id,
        campaignId,
        JSON.stringify(testCase.body),
      );
      const body: ErrorBody = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'Budget and currency cannot change once creators are invited',
        code: 'CAMPAIGN_HAS_SLOTS',
      });
      expect(await snapshot(campaignId)).toEqual(before);
    },
  );

  it('still allows a title change while a slot exists', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    await seedSlot(campaignId);
    authState.userId = user.clerkId;

    const res = await callPatch(
      org.id,
      campaignId,
      JSON.stringify({ title: 'Renamed With Slot' }),
    );

    expect(res.status).toBe(200);
    expect((await snapshot(campaignId)).title).toBe('Renamed With Slot');
  });

  it('returns 415 for a non-JSON content type', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;
    const before = await snapshot(campaignId);

    const res = await callPatch(
      org.id,
      campaignId,
      JSON.stringify({ title: 'Renamed' }),
      'text/plain',
    );

    expect(res.status).toBe(415);
    expect(await snapshot(campaignId)).toEqual(before);
  });

  it('returns 400 for malformed JSON', async () => {
    const user = await createUser();
    const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
    const campaignId = await createCampaign(org.id);
    authState.userId = user.clerkId;

    const res = await callPatch(org.id, campaignId, '{not json');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
  });
});
