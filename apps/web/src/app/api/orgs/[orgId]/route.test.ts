// apps/web/src/app/api/orgs/[orgId]/route.test.ts
//
// Real-database integration tests for GET /api/orgs/[orgId].
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only Clerk is mocked. Prisma and Postgres are real; users are seeded directly
// so provisioning resolves them without a Clerk API call.

import { randomUUID } from 'node:crypto';

import { OrganizationRole, PrismaClient } from '@repo/database';
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
    'RUN_DB_TESTS != 1 — org detail route tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface OrgDetailResponse {
  id: string;
  name: string;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
}

describeDb('api/orgs/[orgId]', () => {
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
        `[orgs] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
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
        clerkId: `clerk_test_org_detail_${suffix}`,
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
      select: { id: true, name: true },
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

  function callGet(orgId: string): Promise<Response> {
    return GET(
      new Request(`http://localhost/api/orgs/${encodeURIComponent(orgId)}`),
      // This version of Next.js passes route params as a Promise.
      { params: Promise.resolve({ orgId }) },
    );
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callGet('org_whatever');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([
    OrganizationRole.OWNER,
    OrganizationRole.ADMIN,
    OrganizationRole.MEMBER,
  ])('returns the organization to a %s member with that role', async (role) => {
    const user = await createUser();
    const org = await createOrganization();
    await addMembership(org.id, user.id, role);
    authState.userId = user.clerkId;

    const res = await callGet(org.id);
    const body: OrgDetailResponse = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'role',
      'updatedAt',
    ]);
    expect(body).toEqual({
      id: org.id,
      name: org.name,
      role,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('returns an identical 404 for non-member, unknown org, soft-deleted org and malformed id', async () => {
    const caller = await createUser();
    const stranger = await createUser();
    const liveOrg = await createOrganization();
    await addMembership(liveOrg.id, stranger.id, OrganizationRole.OWNER);
    const deletedOrg = await createOrganization({ deletedAt: new Date() });
    authState.userId = caller.clerkId;

    const responses = [
      await callGet(liveOrg.id), // caller is not a member
      await callGet('org_does_not_exist'), // valid shape, no such row
      await callGet(deletedOrg.id), // soft-deleted
      await callGet('../x'), // malformed
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
    'returns 404 for the malformed id %j',
    async (orgId) => {
      const caller = await createUser();
      authState.userId = caller.clerkId;

      const res = await callGet(orgId);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    },
  );

  it('returns 403 for a soft-deleted caller', async () => {
    const user = await createUser({ deletedAt: new Date() });
    const org = await createOrganization();
    await addMembership(org.id, user.id, OrganizationRole.OWNER);
    authState.userId = user.clerkId;

    const res = await callGet(org.id);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Account disabled' });
  });
});
