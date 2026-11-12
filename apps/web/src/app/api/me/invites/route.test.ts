// apps/web/src/app/api/me/invites/route.test.ts
//
// Real-database integration tests for GET /api/me/invites.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL.
// If RUN_DB_TESTS=1 but the database is unreachable, the suite FAILS LOUDLY —
// it never silently skips.
//
// Only Clerk auth is mocked. Prisma and Postgres are real; users, creators,
// organizations, campaigns and slots are seeded directly so provisioning
// resolves them without a Clerk API call.

import { randomUUID } from 'node:crypto';

import {
  CampaignStatus,
  OrganizationRole,
  PrismaClient,
  SlotStatus,
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
    'RUN_DB_TESTS != 1 — my invites route tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

interface ErrorBody {
  error: string;
}

interface InviteItem {
  id: string;
  status: string;
  escrowAmount: string;
  viewTarget: number | null;
  metric: string | null;
  invitedAt: string;
  inviteExpiresAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  campaign: {
    id: string;
    title: string;
    description: string | null;
    submissionDeadline: string | null;
  };
  organization: { name: string };
}

interface InviteListBody {
  items: InviteItem[];
  nextCursor: string | null;
}

const MS_PER_DAY = 86_400_000;
const FUTURE_DEADLINE = () => new Date(Date.now() + 30 * MS_PER_DAY);
const FUTURE_EXPIRY = () => new Date(Date.now() + 7 * MS_PER_DAY);

describeDb('api/me/invites GET', () => {
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
        `[me/invites] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
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
        clerkId: `clerk_test_invites_${suffix}`,
        email: `${suffix}@example.com`,
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
      select: { id: true, name: true },
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

  async function createCampaign(
    organizationId: string,
    overrides: {
      status?: CampaignStatus;
      deletedAt?: Date | null;
      submissionDeadline?: Date | null;
    } = {},
  ): Promise<string> {
    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        title: `Campaign ${randomUUID()}`,
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

  /** One campaign (with its own state) plus one slot for `creatorId`. */
  async function createInviteRow(
    organizationId: string,
    creatorId: string,
    overrides: {
      campaignStatus?: CampaignStatus;
      campaignDeletedAt?: Date | null;
      slotStatus?: SlotStatus;
      inviteExpiresAt?: Date | null;
      slotDeletedAt?: Date | null;
      invitedAt?: Date;
      escrowAmount?: string;
    } = {},
  ): Promise<{ campaignId: string; slotId: string }> {
    const campaignId = await createCampaign(organizationId, {
      status: overrides.campaignStatus ?? CampaignStatus.ACTIVE,
      deletedAt: overrides.campaignDeletedAt ?? null,
    });
    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId,
        creatorId,
        status: overrides.slotStatus ?? SlotStatus.INVITED,
        escrowAmount: overrides.escrowAmount ?? '40.00',
        viewTarget: 1000,
        metric: 'engagedViews',
        invitedAt: overrides.invitedAt ?? new Date(),
        inviteExpiresAt:
          overrides.inviteExpiresAt === undefined
            ? FUTURE_EXPIRY()
            : overrides.inviteExpiresAt,
        deletedAt: overrides.slotDeletedAt ?? null,
      },
      select: { id: true },
    });
    return { campaignId, slotId: slot.id };
  }

  /** Caller with a live creator profile and a live YouTube account. */
  async function setupCreator() {
    const user = await createUser();
    const creator = await createCreatorFor(user.id);
    await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: 'YOUTUBE',
        externalId: `ext_${randomUUID()}`,
        scopes: ['yt-analytics.readonly'],
        revokedAt: null,
      },
      select: { id: true },
    });
    const org = await createOrganization();
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: OrganizationRole.OWNER },
      select: { id: true },
    });
    authState.userId = user.clerkId;
    return {
      userId: user.id,
      clerkId: user.clerkId,
      email: user.email,
      creatorId: creator.id,
      organizationId: org.id,
      organizationName: org.name,
    };
  }

  function callList(query = ''): Promise<Response> {
    const suffix = query === '' ? '' : `?${query}`;
    return GET(new Request(`http://localhost/api/me/invites${suffix}`));
  }

  async function listBody(query = ''): Promise<InviteListBody> {
    const res = await callList(query);
    expect(res.status).toBe(200);
    const body: InviteListBody = await res.json();
    return body;
  }

  // ---------------------------------------------------------------------------
  // Listing: authentication, no creator, and only actionable invites
  // ---------------------------------------------------------------------------

  it('returns 401 when unauthenticated', async () => {
    const res = await callList();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns an empty page for a user with no creator profile', async () => {
    const user = await createUser();
    authState.userId = user.clerkId;

    const body = await listBody();

    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it('returns only the caller’s own actionable invites', async () => {
    const caller = await setupCreator();
    const orgId = caller.organizationId;

    // (a) the only row that must be returned.
    const pending = await createInviteRow(orgId, caller.creatorId);

    // (b)-(f) not pending, expired, or soft-deleted.
    await createInviteRow(orgId, caller.creatorId, {
      slotStatus: SlotStatus.ACCEPTED,
    });
    await createInviteRow(orgId, caller.creatorId, {
      slotStatus: SlotStatus.DECLINED,
    });
    await createInviteRow(orgId, caller.creatorId, {
      slotStatus: SlotStatus.EXPIRED,
    });
    await createInviteRow(orgId, caller.creatorId, {
      inviteExpiresAt: new Date(Date.now() - MS_PER_DAY),
    });
    await createInviteRow(orgId, caller.creatorId, { inviteExpiresAt: null });
    await createInviteRow(orgId, caller.creatorId, {
      slotDeletedAt: new Date(),
    });

    // (g) the campaign is not active.
    for (const status of [
      CampaignStatus.DRAFT,
      CampaignStatus.PAUSED,
      CampaignStatus.CANCELLED,
    ]) {
      await createInviteRow(orgId, caller.creatorId, {
        campaignStatus: status,
      });
    }

    // (h) soft-deleted campaign, (i) soft-deleted organization.
    await createInviteRow(orgId, caller.creatorId, {
      campaignDeletedAt: new Date(),
    });
    const deadOrg = await createOrganization({ deletedAt: new Date() });
    await createInviteRow(deadOrg.id, caller.creatorId);

    // (j) another creator’s pending invite.
    const otherUser = await createUser();
    const otherCreator = await createCreatorFor(otherUser.id);
    await createInviteRow(orgId, otherCreator.id);

    const body = await listBody();

    expect(body.items.map((item) => item.id)).toEqual([pending.slotId]);
    expect(body.nextCursor).toBeNull();
  });

  it('returns the serializer shape with no identity fields', async () => {
    const caller = await setupCreator();
    // Must be relative to now: the route only returns invites whose expiry is
    // still in the future, and a hardcoded January 2026 date is already past.
    const invitedAt = new Date(Date.now() - MS_PER_DAY);
    const expiresAt = new Date(Date.now() + 7 * MS_PER_DAY);
    const row = await createInviteRow(caller.organizationId, caller.creatorId, {
      escrowAmount: '40',
      invitedAt,
      inviteExpiresAt: expiresAt,
    });

    const body = await listBody();

    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    if (item === undefined) throw new Error('expected one invite');

    expect(Object.keys(item).sort()).toEqual(
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
    expect(Object.keys(item.campaign).sort()).toEqual(
      ['description', 'id', 'submissionDeadline', 'title'].sort(),
    );
    expect(Object.keys(item.organization).sort()).toEqual(['name']);
    expect(item.campaign).not.toHaveProperty('organization');

    expect(item.id).toBe(row.slotId);
    expect(item.status).toBe(SlotStatus.INVITED);
    expect(item.escrowAmount).toBe('40.00');
    expect(typeof item.escrowAmount).toBe('string');
    expect(item.viewTarget).toBe(1000);
    expect(item.metric).toBe('engagedViews');
    expect(new Date(item.invitedAt).getTime()).toBe(invitedAt.getTime());
    expect(new Date(item.inviteExpiresAt ?? 0).getTime()).toBe(
      expiresAt.getTime(),
    );
    expect(item.acceptedAt).toBeNull();
    expect(item.declinedAt).toBeNull();
    expect(item.campaign.id).toBe(row.campaignId);
    expect(item.organization.name).toBe(caller.organizationName);

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
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  function requireCursor(cursor: string | null): string {
    if (cursor === null) throw new Error('expected a next cursor');
    return cursor;
  }

  it('walks five pending invites in pages of two without duplicates or omissions', async () => {
    const caller = await setupCreator();
    const base = Date.now() - 10 * MS_PER_DAY;
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const row = await createInviteRow(caller.organizationId, caller.creatorId, {
        invitedAt: new Date(base + index * 60_000),
        escrowAmount: '10.00',
      });
      created.push(row.slotId);
    }
    const expected = [...created].reverse();

    const page1 = await listBody('limit=2');
    expect(page1.items.map((item) => item.id)).toEqual(expected.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listBody(
      `limit=2&cursor=${requireCursor(page1.nextCursor)}`,
    );
    expect(page2.items.map((item) => item.id)).toEqual(expected.slice(2, 4));
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listBody(
      `limit=2&cursor=${requireCursor(page2.nextCursor)}`,
    );
    expect(page3.items.map((item) => item.id)).toEqual(expected.slice(4));
    expect(page3.nextCursor).toBeNull();

    const seen = [
      ...page1.items.map((item) => item.id),
      ...page2.items.map((item) => item.id),
      ...page3.items.map((item) => item.id),
    ];
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  // ---------------------------------------------------------------------------
  // Cursor ownership and query validation
  // ---------------------------------------------------------------------------

  it('rejects another creator’s slot id as a cursor', async () => {
    const caller = await setupCreator();
    const otherUser = await createUser();
    const otherCreator = await createCreatorFor(otherUser.id);
    const foreign = await createInviteRow(
      caller.organizationId,
      otherCreator.id,
    );

    const res = await callList(`cursor=${foreign.slotId}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid cursor' });
  });

  it('accepts the caller’s own non-pending slot id as a cursor', async () => {
    const caller = await setupCreator();
    const accepted = await createInviteRow(
      caller.organizationId,
      caller.creatorId,
      {
        slotStatus: SlotStatus.ACCEPTED,
        invitedAt: new Date(Date.now() - MS_PER_DAY),
      },
    );
    await createInviteRow(caller.organizationId, caller.creatorId, {
      invitedAt: new Date(Date.now() - 2 * MS_PER_DAY),
    });

    const res = await callList(`cursor=${accepted.slotId}`);

    expect(res.status).toBe(200);
    const body: InviteListBody = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it.each([
    { label: 'a zero limit', query: 'limit=0' },
    { label: 'a limit above the maximum', query: 'limit=51' },
    { label: 'a non-numeric limit', query: 'limit=abc' },
    { label: 'an unknown parameter', query: 'page=1' },
  ])('returns 400 for $label', async (testCase) => {
    const caller = await setupCreator();
    await createInviteRow(caller.organizationId, caller.creatorId);

    const res = await callList(testCase.query);

    expect(res.status).toBe(400);
    const body: ErrorBody = await res.json();
    expect(body.error).toBe('Invalid request');
  });

  it('returns 400 for a duplicate query parameter', async () => {
    const caller = await setupCreator();
    await createInviteRow(caller.organizationId, caller.creatorId);

    const res = await callList('limit=2&limit=2');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Duplicate query parameter' });
  });
});
