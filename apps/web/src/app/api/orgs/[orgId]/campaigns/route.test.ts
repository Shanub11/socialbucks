// apps/web/src/app/api/orgs/[orgId]/campaigns/route.test.ts
//
// Real-database integration tests for POST /api/orgs/[orgId]/campaigns and
// GET /api/orgs/[orgId]/campaigns.
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

import { MAX_DRAFT_CAMPAIGNS_PER_ORG } from '@/lib/campaigns/constants';
import { resetTestDatabase } from '@/test/reset-test-db';

import { GET, POST } from './route';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — campaign collection route tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
  code?: string;
  issues?: Array<{ path: string; message: string }>;
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

interface ListCampaignsResponse {
  items: SerializedCampaignBody[];
  nextCursor: string | null;
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
  { label: 'a missing title', body: { totalBudget: '100.00' } },
  { label: 'a missing total budget', body: { title: 'Spring Launch' } },
  {
    label: 'a JSON number budget',
    body: { title: 'Spring Launch', totalBudget: 100 },
  },
  { label: 'a zero budget', body: { title: 'Spring Launch', totalBudget: '0' } },
  {
    label: 'a sub-cent budget',
    body: { title: 'Spring Launch', totalBudget: '1.234' },
  },
  {
    label: 'an unsupported currency',
    body: { title: 'Spring Launch', totalBudget: '100.00', currency: 'EUR' },
  },
  {
    label: 'a past deadline',
    body: {
      title: 'Spring Launch',
      totalBudget: '100.00',
      submissionDeadline: '2020-01-01T00:00:00Z',
    },
  },
  {
    label: 'a status key',
    body: { title: 'Spring Launch', totalBudget: '100.00', status: 'ACTIVE' },
  },
  {
    label: 'an organizationId key',
    body: {
      title: 'Spring Launch',
      totalBudget: '100.00',
      organizationId: 'org_other',
    },
  },
  {
    label: 'an id key',
    body: { title: 'Spring Launch', totalBudget: '100.00', id: 'campaign_x' },
  },
];

describeDb('api/orgs/[orgId]/campaigns', () => {
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
        clerkId: `clerk_test_campaigns_${suffix}`,
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

  /** Creates an organization with the given user as a member of `role`. */
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
      createdAt?: Date;
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
        ...(overrides.createdAt !== undefined
          ? { createdAt: overrides.createdAt }
          : {}),
      },
      select: { id: true },
    });
    return campaign.id;
  }

  async function readStored(id: string) {
    const stored = await prisma.campaign.findUnique({
      where: { id },
      select: {
        organizationId: true,
        status: true,
        currency: true,
        totalBudget: true,
        submissionDeadline: true,
        description: true,
      },
    });
    if (!stored) throw new Error('expected the campaign row to exist');
    return stored;
  }

  function validBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      title: 'Spring Launch',
      totalBudget: '100.00',
      ...overrides,
    });
  }

  function callPost(
    orgId: string,
    body: string,
    contentType: string | null = 'application/json',
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (contentType !== null) headers['content-type'] = contentType;
    return POST(
      new Request(
        `http://localhost/api/orgs/${encodeURIComponent(orgId)}/campaigns`,
        { method: 'POST', headers, body },
      ),
      { params: Promise.resolve({ orgId }) },
    );
  }

  function callList(orgId: string, query = ''): Promise<Response> {
    return GET(
      new Request(
        `http://localhost/api/orgs/${encodeURIComponent(orgId)}/campaigns${query}`,
      ),
      { params: Promise.resolve({ orgId }) },
    );
  }

  // ---------------------------------------------------------------------------
  // POST /api/orgs/[orgId]/campaigns
  // ---------------------------------------------------------------------------

  describe('POST /api/orgs/[orgId]/campaigns', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await callPost('org_whatever', validBody());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(await prisma.campaign.count()).toBe(0);
    });

    it.each([OrganizationRole.OWNER, OrganizationRole.ADMIN])(
      'creates a DRAFT campaign for a %s',
      async (role) => {
        const user = await createUser();
        const org = await createOrgWithMember(user.id, role);
        authState.userId = user.clerkId;

        const res = await callPost(org.id, validBody());
        const body: SerializedCampaignBody = await res.json();

        expect(res.status).toBe(201);
        expect(Object.keys(body).sort()).toEqual(SERIALIZED_KEYS);
        expect(body.organizationId).toBe(org.id);
        expect(body.title).toBe('Spring Launch');
        expect(body.description).toBeNull();
        expect(body.status).toBe(CampaignStatus.DRAFT);
        expect(body.totalBudget).toBe('100.00');
        expect(body.currency).toBe('USD');
        expect(body.submissionDeadline).toBeNull();
        expect(body.id).toEqual(expect.any(String));
        expect(body.createdAt).toEqual(expect.any(String));
        expect(body.updatedAt).toEqual(expect.any(String));

        const stored = await readStored(body.id);
        expect(stored.organizationId).toBe(org.id);
        expect(stored.status).toBe(CampaignStatus.DRAFT);
        expect(stored.currency).toBe('USD');
        expect(stored.totalBudget.toFixed(2)).toBe('100.00');
        expect(stored.submissionDeadline).toBeNull();
        expect(stored.description).toBeNull();
      },
    );

    it('round-trips the largest allowed budget to the cent', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;

      const res = await callPost(
        org.id,
        validBody({ totalBudget: '9999999999.99' }),
      );
      const body: SerializedCampaignBody = await res.json();

      expect(res.status).toBe(201);
      expect(body.totalBudget).toBe('9999999999.99');

      const stored = await readStored(body.id);
      expect(stored.totalBudget.toFixed(2)).toBe('9999999999.99');
    });

    it('stores a description and deadline when supplied', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;
      const deadline = new Date(Date.now() + 30 * 86_400_000).toISOString();

      const res = await callPost(
        org.id,
        validBody({ description: 'Line one\nLine two', submissionDeadline: deadline }),
      );
      const body: SerializedCampaignBody = await res.json();

      expect(res.status).toBe(201);
      expect(body.description).toBe('Line one\nLine two');
      expect(body.submissionDeadline).toBe(deadline);
    });

    it('returns 403 for a MEMBER and creates nothing', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.MEMBER);
      authState.userId = user.clerkId;

      const res = await callPost(org.id, validBody());

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
      expect(await prisma.campaign.count()).toBe(0);
    });

    it('returns an identical 404 for non-member, unknown org, malformed org id and soft-deleted org', async () => {
      const caller = await createUser();
      const stranger = await createUser();
      const liveOrg = await createOrganization();
      await addMembership(liveOrg.id, stranger.id, OrganizationRole.OWNER);
      const deletedOrg = await createOrganization({ deletedAt: new Date() });
      authState.userId = caller.clerkId;

      const responses = [
        await callPost(liveOrg.id, validBody()), // caller is not a member
        await callPost('org_does_not_exist', validBody()), // valid shape, no row
        await callPost('a b', validBody()), // malformed
        await callPost(deletedOrg.id, validBody()), // soft-deleted
      ];

      for (const res of responses) {
        expect(res.status).toBe(404);
      }

      const bodies = await Promise.all(responses.map((res) => res.json()));
      expect(bodies[0]).toEqual({ error: 'Not found' });
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(bodies[3]).toEqual(bodies[0]);
      expect(await prisma.campaign.count()).toBe(0);
    });

    it.each(INVALID_BODIES)(
      'returns 400 for $label and creates nothing',
      async (testCase) => {
        const user = await createUser();
        const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
        authState.userId = user.clerkId;

        const res = await callPost(org.id, JSON.stringify(testCase.body));
        const body: ErrorBody = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe('Invalid request');
        expect(await prisma.campaign.count()).toBe(0);
      },
    );

    it('returns 415 for a non-JSON content type', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;

      const res = await callPost(org.id, validBody(), 'text/plain');

      expect(res.status).toBe(415);
      expect(await prisma.campaign.count()).toBe(0);
    });

    it('returns 400 for malformed JSON', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;

      const res = await callPost(org.id, '{not json');

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid JSON' });
      expect(await prisma.campaign.count()).toBe(0);
    });

    it('creates under the URL organization only', async () => {
      const caller = await createUser();
      const stranger = await createUser();
      const ownOrg = await createOrgWithMember(caller.id, OrganizationRole.OWNER);
      const foreignOrg = await createOrgWithMember(
        stranger.id,
        OrganizationRole.OWNER,
      );
      authState.userId = caller.clerkId;

      const res = await callPost(foreignOrg.id, validBody());

      expect(res.status).toBe(404);
      expect(await prisma.campaign.count()).toBe(0);
      expect(
        await prisma.campaign.count({ where: { organizationId: ownOrg.id } }),
      ).toBe(0);
      expect(
        await prisma.campaign.count({ where: { organizationId: foreignOrg.id } }),
      ).toBe(0);
    });

    it(`returns 409 CAMPAIGN_LIMIT_REACHED at ${MAX_DRAFT_CAMPAIGNS_PER_ORG} drafts`, async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;
      await prisma.campaign.createMany({
        data: Array.from({ length: MAX_DRAFT_CAMPAIGNS_PER_ORG }, (_, i) => ({
          organizationId: org.id,
          title: `Draft ${i}`,
          totalBudget: '10.00',
          status: CampaignStatus.DRAFT,
        })),
      });
      const before = await prisma.campaign.count();

      const res = await callPost(org.id, validBody());

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Draft campaign limit reached',
        code: 'CAMPAIGN_LIMIT_REACHED',
      });
      expect(await prisma.campaign.count()).toBe(before);
    });

    it('does not count ACTIVE or soft-deleted campaigns toward the draft limit', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;
      await prisma.campaign.createMany({
        data: Array.from({ length: MAX_DRAFT_CAMPAIGNS_PER_ORG }, (_, i) => ({
          organizationId: org.id,
          title: `Active ${i}`,
          totalBudget: '10.00',
          status: CampaignStatus.ACTIVE,
        })),
      });
      await prisma.campaign.createMany({
        data: Array.from({ length: MAX_DRAFT_CAMPAIGNS_PER_ORG }, (_, i) => ({
          organizationId: org.id,
          title: `Deleted ${i}`,
          totalBudget: '10.00',
          status: CampaignStatus.DRAFT,
          deletedAt: new Date(),
        })),
      });

      const res = await callPost(org.id, validBody());

      expect(res.status).toBe(201);
    });

    it('does not count another organization’s drafts toward the limit', async () => {
      const user = await createUser();
      const stranger = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      const otherOrg = await createOrgWithMember(
        stranger.id,
        OrganizationRole.OWNER,
      );
      authState.userId = user.clerkId;
      await prisma.campaign.createMany({
        data: Array.from({ length: MAX_DRAFT_CAMPAIGNS_PER_ORG }, (_, i) => ({
          organizationId: otherOrg.id,
          title: `Foreign ${i}`,
          totalBudget: '10.00',
          status: CampaignStatus.DRAFT,
        })),
      });

      const res = await callPost(org.id, validBody());

      expect(res.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/orgs/[orgId]/campaigns
  // ---------------------------------------------------------------------------

  describe('GET /api/orgs/[orgId]/campaigns', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await callList('org_whatever');

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it.each([
      OrganizationRole.OWNER,
      OrganizationRole.ADMIN,
      OrganizationRole.MEMBER,
    ])('lists campaigns for a %s', async (role) => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, role);
      const campaignId = await createCampaign(org.id);
      authState.userId = user.clerkId;

      const res = await callList(org.id);
      const body: ListCampaignsResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.nextCursor).toBeNull();
      expect(body.items.map((item) => item.id)).toEqual([campaignId]);
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(SERIALIZED_KEYS);
        expect(item.organizationId).toBe(org.id);
        expect(typeof item.totalBudget).toBe('string');
        expect(item.totalBudget).toBe('100.00');
      }
    });

    it('returns only this organization’s live campaigns', async () => {
      const user = await createUser();
      const stranger = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      const otherOrg = await createOrgWithMember(
        stranger.id,
        OrganizationRole.OWNER,
      );
      authState.userId = user.clerkId;

      const first = await createCampaign(org.id);
      const second = await createCampaign(org.id);
      await createCampaign(otherOrg.id);
      await createCampaign(org.id, { deletedAt: new Date() });

      const res = await callList(org.id);
      const body: ListCampaignsResponse = await res.json();

      expect(res.status).toBe(200);
      expect([...body.items.map((item) => item.id)].sort()).toEqual(
        [first, second].sort(),
      );
    });

    it('returns an identical 404 for non-member, unknown org, malformed org id and soft-deleted org', async () => {
      const caller = await createUser();
      const stranger = await createUser();
      const liveOrg = await createOrganization();
      await addMembership(liveOrg.id, stranger.id, OrganizationRole.OWNER);
      await createCampaign(liveOrg.id);
      const deletedOrg = await createOrganization({ deletedAt: new Date() });
      authState.userId = caller.clerkId;

      const responses = [
        await callList(liveOrg.id),
        await callList('org_does_not_exist'),
        await callList('a b'),
        await callList(deletedOrg.id),
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

    it('filters by status', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;
      await createCampaign(org.id, { status: CampaignStatus.DRAFT });
      const active = await createCampaign(org.id, {
        status: CampaignStatus.ACTIVE,
      });

      const res = await callList(org.id, '?status=ACTIVE');
      const body: ListCampaignsResponse = await res.json();

      expect(res.status).toBe(200);
      expect(body.items.map((item) => item.id)).toEqual([active]);
      expect(body.items.every((item) => item.status === 'ACTIVE')).toBe(true);
    });

    it('returns 400 for an unknown status', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;

      const res = await callList(org.id, '?status=FOO');

      expect(res.status).toBe(400);
      expect(await prisma.campaign.count()).toBe(0);
    });

    it('pages with a cursor without duplicates or omissions', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;

      const base = Date.parse('2026-01-01T00:00:00.000Z');
      const campaignIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const campaignId = await createCampaign(org.id, {
          createdAt: new Date(base + i * 60_000),
        });
        campaignIds.push(campaignId);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      for (let i = 0; i < 10; i += 1) {
        const query =
          cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
        const res = await callList(org.id, query);
        expect(res.status).toBe(200);

        const body: ListCampaignsResponse = await res.json();
        pages += 1;
        seen.push(...body.items.map((item) => item.id));

        if (body.nextCursor === null) break;
        cursor = body.nextCursor;
      }

      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...campaignIds].sort());
    });

    it('rejects a cursor that belongs to another organization', async () => {
      const user = await createUser();
      const stranger = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      const otherOrg = await createOrgWithMember(
        stranger.id,
        OrganizationRole.OWNER,
      );
      authState.userId = user.clerkId;
      await createCampaign(org.id);
      const foreignCampaign = await createCampaign(otherOrg.id);

      const res = await callList(org.id, `?cursor=${foreignCampaign}`);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid cursor' });
    });

    it('rejects a cursor pointing at a soft-deleted campaign', async () => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;
      await createCampaign(org.id);
      const deletedCampaign = await createCampaign(org.id, {
        deletedAt: new Date(),
      });

      const res = await callList(org.id, `?cursor=${deletedCampaign}`);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid cursor' });
    });

    it.each([
      '?limit=0',
      '?limit=51',
      '?limit=abc',
      '?page=1',
      '?limit=2&limit=2',
    ])('returns 400 for the invalid query string (%s)', async (query) => {
      const user = await createUser();
      const org = await createOrgWithMember(user.id, OrganizationRole.OWNER);
      authState.userId = user.clerkId;

      const res = await callList(org.id, query);

      expect(res.status).toBe(400);
    });
  });
});
