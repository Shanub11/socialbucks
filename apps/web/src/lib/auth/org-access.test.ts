// apps/web/src/lib/auth/org-access.test.ts
//
// Real-database integration tests for the shared organization-access helper.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only Clerk is mocked (ensure-user imports clerkClient at module load) and
// ensure-user is a *delegating* mock: by default it calls the real function,
// and individual tests override exactly one call with mockResolvedValueOnce.

import { randomUUID } from 'node:crypto';

import { OrganizationRole, PrismaClient } from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
  clerkClient: vi.fn(),
}));

vi.mock('@/lib/auth/ensure-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/ensure-user')>();
  return { ...actual, ensureUserProvisioned: vi.fn(actual.ensureUserProvisioned) };
});

import { ensureUserProvisioned } from '@/lib/auth/ensure-user';
import {
  ORG_MANAGER_ROLES,
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
  requireOrgRole,
} from './org-access';
import type { OrgAccess, OrgAccessDenied, OrgAccessGranted } from './org-access';
import { resetTestDatabase } from '@/test/reset-test-db';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn('RUN_DB_TESTS != 1 — org-access tests are SKIPPED, not passing.');
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDb('org-access helper (real DB)', () => {
  // Skipped suites never connect, so the empty fallback below is only ever
  // handed to a lazily constructed pool; with RUN_DB_TESTS=1 it must be real.
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
        `[org-access] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTestDatabase(prisma);
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  const CLERK_PREFIX = 'clerk_test_org_access_';

  async function createUser(overrides: { deletedAt?: Date } = {}) {
    const suffix = randomUUID();
    return prisma.user.create({
      data: {
        clerkId: `${CLERK_PREFIX}${suffix}`,
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

  async function addMember(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
  ) {
    return prisma.organizationMember.create({
      data: { organizationId, userId, role },
      select: { id: true },
    });
  }

  // ---------------------------------------------------------------------------
  // getOrgAccess: a live member resolves with their real role
  // ---------------------------------------------------------------------------

  describe('getOrgAccess — membership resolution', () => {
    it.each([
      OrganizationRole.OWNER,
      OrganizationRole.ADMIN,
      OrganizationRole.MEMBER,
    ])('resolves a %s membership with that role and the internal user id', async (role) => {
      const user = await createUser();
      const org = await createOrganization();
      await addMember(org.id, user.id, role);

      const access = await getOrgAccess(user.id, org.id);

      expect(access).toEqual({
        ok: true,
        userId: user.id,
        organizationId: org.id,
        role,
      });
    });

    it('returns the identical NOT_FOUND for unknown org, soft-deleted org and non-member', async () => {
      const user = await createUser();
      const liveOrg = await createOrganization();
      const deletedOrg = await createOrganization({ deletedAt: new Date() });

      const unknown = await getOrgAccess(user.id, 'org_does_not_exist');
      const softDeleted = await getOrgAccess(user.id, deletedOrg.id);
      const nonMember = await getOrgAccess(user.id, liveOrg.id);

      expect(unknown).toEqual({ ok: false, reason: 'NOT_FOUND' });
      expect(softDeleted).toEqual({ ok: false, reason: 'NOT_FOUND' });
      expect(nonMember).toEqual({ ok: false, reason: 'NOT_FOUND' });
      expect(softDeleted).toEqual(unknown);
      expect(nonMember).toEqual(unknown);
    });

    it('returns NOT_FOUND when a member of org A asks about org B', async () => {
      const user = await createUser();
      const orgA = await createOrganization();
      const orgB = await createOrganization();
      await addMember(orgA.id, user.id, OrganizationRole.OWNER);

      const access = await getOrgAccess(user.id, orgB.id);

      expect(access).toEqual({ ok: false, reason: 'NOT_FOUND' });
    });

    it('exposes only ok and reason on a denied result, never org data', async () => {
      const member = await createUser();
      const outsider = await createUser();
      const org = await createOrganization();
      await addMember(org.id, member.id, OrganizationRole.MEMBER);

      const denied = await getOrgAccess(outsider.id, org.id);

      expect(denied.ok).toBe(false);
      expect(Object.keys(denied).sort()).toEqual(['ok', 'reason']);
      expect(JSON.stringify(denied)).not.toContain(org.name);
    });
  });

  // ---------------------------------------------------------------------------
  // requireOrgRole: write gate on top of the shared access result
  // ---------------------------------------------------------------------------

  describe('requireOrgRole', () => {
    it.each([OrganizationRole.OWNER, OrganizationRole.ADMIN])(
      'passes a granted %s through unchanged',
      (role) => {
        const access: OrgAccessGranted = {
          ok: true,
          userId: 'user_manager',
          organizationId: 'org_1',
          role,
        };

        expect(requireOrgRole(access, ORG_MANAGER_ROLES)).toBe(access);
      },
    );

    it('turns a MEMBER into FORBIDDEN', () => {
      const access: OrgAccess = {
        ok: true,
        userId: 'user_member',
        organizationId: 'org_1',
        role: OrganizationRole.MEMBER,
      };

      expect(requireOrgRole(access, ORG_MANAGER_ROLES)).toEqual({
        ok: false,
        reason: 'FORBIDDEN',
      });
    });

    it('passes a NOT_FOUND result through unchanged', () => {
      const access: OrgAccessDenied = { ok: false, reason: 'NOT_FOUND' };

      expect(requireOrgRole(access, ORG_MANAGER_ROLES)).toBe(access);
    });
  });

  // ---------------------------------------------------------------------------
  // orgAccessErrorResponse: the only mapping from reason to HTTP status
  // ---------------------------------------------------------------------------

  describe('orgAccessErrorResponse', () => {
    it('maps NOT_FOUND to 404 { error: "Not found" } with no reason key', async () => {
      const response = orgAccessErrorResponse('NOT_FOUND');

      expect(response.status).toBe(404);
      const body: unknown = await response.json();
      expect(body).toEqual({ error: 'Not found' });
      expect(body).not.toHaveProperty('reason');
    });

    it('maps FORBIDDEN to 403 { error: "Forbidden" } with no reason key', async () => {
      const response = orgAccessErrorResponse('FORBIDDEN');

      expect(response.status).toBe(403);
      const body: unknown = await response.json();
      expect(body).toEqual({ error: 'Forbidden' });
      expect(body).not.toHaveProperty('reason');
    });
  });

  // ---------------------------------------------------------------------------
  // provisionedUserOrResponse: provisioning outcomes mapped to HTTP
  // ---------------------------------------------------------------------------

  describe('provisionedUserOrResponse', () => {
    it('returns the internal user id for a live seeded user via the real provisioner', async () => {
      const user = await createUser();

      const result = await provisionedUserOrResponse(user.clerkId);

      expect(result).toEqual({ ok: true, userId: user.id });
      expect(vi.mocked(ensureUserProvisioned)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ensureUserProvisioned)).toHaveBeenCalledWith(user.clerkId);
    });

    it('maps a soft-deleted seeded user to 403 { error: "Account disabled" }', async () => {
      const user = await createUser({ deletedAt: new Date() });

      const result = await provisionedUserOrResponse(user.clerkId);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a denied provision result');
      expect(result.response.status).toBe(403);
      const body: unknown = await result.response.json();
      expect(body).toEqual({ error: 'Account disabled' });
      expect(body).not.toHaveProperty('reason');
    });

    it('maps clerk_lookup_failed to 503 { error: "Service temporarily unavailable" }', async () => {
      vi.mocked(ensureUserProvisioned).mockResolvedValueOnce({
        ok: false,
        reason: 'clerk_lookup_failed',
      });

      const result = await provisionedUserOrResponse('clerk_test_unreachable');

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a denied provision result');
      expect(result.response.status).toBe(503);
      const body: unknown = await result.response.json();
      expect(body).toEqual({ error: 'Service temporarily unavailable' });
      expect(body).not.toHaveProperty('reason');
      expect(vi.mocked(ensureUserProvisioned)).toHaveBeenCalledTimes(1);
    });
  });
});
