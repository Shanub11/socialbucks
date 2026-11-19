// apps/web/src/app/api/orgs/route.test.ts
//
// Real-database integration tests for POST /api/orgs and GET /api/orgs.
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

// auth() is the only Clerk surface these routes reach. vi.hoisted keeps the
// holder available to the hoisted vi.mock factory.
const authState = vi.hoisted(() => {
  const state: { userId: string | null } = { userId: null };
  return state;
});

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ userId: authState.userId, sessionClaims: null })),
  clerkClient: vi.fn(),
}));

import { MAX_OWNED_ORGS_PER_USER } from '@/lib/orgs/constants';
import { resetTestDatabase } from '@/test/reset-test-db';

import { GET, POST } from './route';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn('RUN_DB_TESTS != 1 — orgs route tests are SKIPPED, not passing.');
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
  code?: string;
  issues?: Array<{ path: string; message: string }>;
}

interface CreateOrgResponse {
  id: string;
  name: string;
  role: string;
  createdAt: string;
}

interface ListOrgsResponse {
  items: Array<{
    id: string;
    name: string;
    role: OrganizationRole;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

describeDb('api/orgs', () => {
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
        clerkId: `clerk_test_orgs_${suffix}`,
        email: `${suffix}@example.com`,
        deletedAt: overrides.deletedAt ?? null,
      },
      select: { id: true, clerkId: true },
    });
  }

  async function createOwnedOrg(
    userId: string,
    options: { role?: OrganizationRole; deletedAt?: Date } = {},
  ): Promise<string> {
    const suffix = randomUUID();
    const org = await prisma.organization.create({
      data: {
        name: `Org ${suffix}`,
        deletedAt: options.deletedAt ?? null,
      },
      select: { id: true },
    });
    await prisma.organizationMember.create({
      data: {
        organizationId: org.id,
        userId,
        role: options.role ?? OrganizationRole.OWNER,
      },
      select: { id: true },
    });
    return org.id;
  }

  function postRequest(body: string, contentType: string | null = 'application/json'): Request {
    const headers: Record<string, string> = {};
    if (contentType !== null) headers['content-type'] = contentType;
    return new Request('http://localhost/api/orgs', {
      method: 'POST',
      headers,
      body,
    });
  }

  function listRequest(query = ''): Request {
    return new Request(`http://localhost/api/orgs${query}`);
  }

  // ---------------------------------------------------------------------------
  // POST /api/orgs
  // ---------------------------------------------------------------------------

  describe('POST /api/orgs', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await POST(postRequest(JSON.stringify({ name: 'Acme' })));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(await prisma.organization.count()).toBe(0);
      expect(await prisma.organizationMember.count()).toBe(0);
    });

    it('creates the organization and its OWNER membership, returning only public fields', async () => {
      const user = await createUser();
      authState.userId = user.clerkId;

      const res = await POST(postRequest(JSON.stringify({ name: '  Acme  ' })));
      const body: CreateOrgResponse = await res.json();

      expect(res.status).toBe(201);
      expect(Object.keys(body).sort()).toEqual([
        'createdAt',
        'id',
        'name',
        'role',
      ]);
      expect(body).not.toHaveProperty('clerkOrgId');
      expect(body).not.toHaveProperty('deletedAt');
      expect(body).not.toHaveProperty('updatedAt');
      expect(body.name).toBe('Acme');
      expect(body.role).toBe(OrganizationRole.OWNER);
      expect(body.id).toEqual(expect.any(String));
      expect(body.createdAt).toEqual(expect.any(String));

      const org = await prisma.organization.findUnique({
        where: { id: body.id },
        select: { name: true, clerkOrgId: true, deletedAt: true },
      });
      expect(org).toEqual({ name: 'Acme', clerkOrgId: null, deletedAt: null });

      const membership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: body.id,
            userId: user.id,
          },
        },
        select: { role: true },
      });
      expect(membership).toEqual({ role: OrganizationRole.OWNER });
    });

    it('stores the name trimmed and NFC-normalized', async () => {
      const user = await createUser();
      authState.userId = user.clerkId;

      const res = await POST(
        postRequest(JSON.stringify({ name: '  Cafe\u0301  ' })),
      );
      expect(res.status).toBe(201);

      const body: CreateOrgResponse = await res.json();
      const org = await prisma.organization.findUnique({
        where: { id: body.id },
        select: { name: true },
      });
      expect(org).toEqual({ name: 'Café' });
    });

    it('returns 400 for a missing name and creates nothing', async () => {
      const user = await createUser();
      authState.userId = user.clerkId;

      const res = await POST(postRequest(JSON.stringify({})));
      const body: ErrorBody = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('Invalid request');
      expect(body.issues?.some((issue) => issue.path === 'name')).toBe(true);
      expect(await prisma.organization.count()).toBe(0);
    });

    it('returns 400 when the body tries to set a role, and creates nothing', async () => {
      const user = await createUser();
      authState.userId = user.clerkId;

      const res = await POST(
        postRequest(JSON.stringify({ name: 'Acme', role: 'OWNER' })),
      );
      const body: ErrorBody = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('Invalid request');
      expect(await prisma.organization.count()).toBe(0);
    });

    it('returns 400 for malformed JSON', async () => {
      const user = await createUser();
      authState.userId = user.clerkId;

      const res = await POST(postRequest('{not json'));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid JSON' });
      expect(await prisma.organization.count()).toBe(0);
    });

    it('returns 415 for a non-JSON content type', async () => {
      const user = await createUser();
      authState.userId = user.clerkId;

      const res = await POST(
        postRequest(JSON.stringify({ name: 'Acme' }), 'text/plain'),
      );

      expect(res.status).toBe(415);
      expect(await prisma.organization.count()).toBe(0);
    });

    it('returns 403 for a soft-deleted user and creates no organization', async () => {
      const user = await createUser({ deletedAt: new Date() });
      authState.userId = user.clerkId;

      const res = await POST(postRequest(JSON.stringify({ name: 'Acme' })));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Account disabled' });
      expect(await prisma.organization.count()).toBe(0);
    });

    it('validates before provisioning: an invalid body creates no User row', async () => {
      // No User row exists for this Clerk id; if validation ran after
      // provisioning, ensureUserProvisioned would have tried to create one.
      authState.userId = 'clerk_test_unprovisioned_invalid_body';

      const res = await POST(
        postRequest(JSON.stringify({ name: 'Acme', role: 'OWNER' })),
      );

      expect(res.status).toBe(400);
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.organization.count()).toBe(0);
    });

    it(`returns 409 ORG_LIMIT_REACHED at ${MAX_OWNED_ORGS_PER_USER} owned organizations`, async () => {
      const user = await createUser();
      authState.userId = user.clerkId;
      for (let i = 0; i < MAX_OWNED_ORGS_PER_USER; i += 1) {
        await createOwnedOrg(user.id);
      }
      const before = await prisma.organization.count();

      const res = await POST(postRequest(JSON.stringify({ name: 'One More' })));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Organization limit reached',
        code: 'ORG_LIMIT_REACHED',
      });
      expect(await prisma.organization.count()).toBe(before);
    });

    it('does not count soft-deleted organizations toward the limit', async () => {
      const user = await createUser();
      authState.userId = user.clerkId;
      for (let i = 0; i < MAX_OWNED_ORGS_PER_USER; i += 1) {
        await createOwnedOrg(user.id, { deletedAt: new Date() });
      }

      const res = await POST(postRequest(JSON.stringify({ name: 'Acme' })));

      expect(res.status).toBe(201);
    });

    it('does not count organizations the user only administers or belongs to', async () => {
      const user = await createUser();
      authState.userId = user.clerkId;
      for (let i = 0; i < MAX_OWNED_ORGS_PER_USER; i += 1) {
        await createOwnedOrg(user.id, {
          role: i % 2 === 0 ? OrganizationRole.ADMIN : OrganizationRole.MEMBER,
        });
      }

      const res = await POST(postRequest(JSON.stringify({ name: 'Acme' })));

      expect(res.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/orgs
  // ---------------------------------------------------------------------------

  describe('GET /api/orgs', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await GET(listRequest());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
    });

    it('lists only the caller’s live organizations, each with their real role', async () => {
      const caller = await createUser();
      const other = await createUser();
      authState.userId = caller.clerkId;

      const owned = await createOwnedOrg(caller.id, {
        role: OrganizationRole.OWNER,
      });
      const administered = await createOwnedOrg(caller.id, {
        role: OrganizationRole.ADMIN,
      });
      const member = await createOwnedOrg(caller.id, {
        role: OrganizationRole.MEMBER,
      });
      const deleted = await createOwnedOrg(caller.id, {
        role: OrganizationRole.OWNER,
        deletedAt: new Date(),
      });
      const foreign = await createOwnedOrg(other.id, {
        role: OrganizationRole.OWNER,
      });

      const res = await GET(listRequest());
      const body: ListOrgsResponse = await res.json();

      expect(res.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
      expect(body.nextCursor).toBeNull();

      const rolesById = new Map(body.items.map((item) => [item.id, item.role]));
      expect(rolesById.size).toBe(3);
      expect(rolesById.get(owned)).toBe(OrganizationRole.OWNER);
      expect(rolesById.get(administered)).toBe(OrganizationRole.ADMIN);
      expect(rolesById.get(member)).toBe(OrganizationRole.MEMBER);
      expect(rolesById.has(deleted)).toBe(false);
      expect(rolesById.has(foreign)).toBe(false);

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'createdAt',
          'id',
          'name',
          'role',
        ]);
      }
    });

    it('pages with a cursor without duplicates or omissions', async () => {
      const caller = await createUser();
      authState.userId = caller.clerkId;

      const base = Date.parse('2026-01-01T00:00:00.000Z');
      const orgIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const orgId = await createOwnedOrg(caller.id);
        // Explicit, distinct membership timestamps make the cursor order
        // deterministic instead of depending on same-millisecond inserts.
        await prisma.organizationMember.update({
          where: {
            organizationId_userId: { organizationId: orgId, userId: caller.id },
          },
          data: { createdAt: new Date(base + i * 60_000) },
          select: { id: true },
        });
        orgIds.push(orgId);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      for (let i = 0; i < 10; i += 1) {
        const suffix =
          cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
        const res = await GET(listRequest(suffix));
        expect(res.status).toBe(200);

        const body: ListOrgsResponse = await res.json();
        pages += 1;
        seen.push(...body.items.map((item) => item.id));

        if (body.nextCursor === null) break;
        cursor = body.nextCursor;
      }

      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...orgIds].sort());
    });

    it('rejects a cursor that belongs to another user', async () => {
      const caller = await createUser();
      const other = await createUser();
      authState.userId = caller.clerkId;
      await createOwnedOrg(caller.id);
      const foreignOrgId = await createOwnedOrg(other.id);

      const foreignMembership = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: foreignOrgId,
            userId: other.id,
          },
        },
        select: { id: true },
      });
      if (!foreignMembership) throw new Error('fixture membership missing');

      const res = await GET(listRequest(`?cursor=${foreignMembership.id}`));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid cursor' });
    });

    it.each([
      '?limit=0',
      '?limit=51',
      '?limit=abc',
      '?page=1',
      '?limit=2&limit=3',
    ])('returns 400 for an invalid query string (%s)', async (query) => {
      const caller = await createUser();
      authState.userId = caller.clerkId;

      const res = await GET(listRequest(query));

      expect(res.status).toBe(400);
    });
  });
});
