// apps/web/src/app/api/campaigns/slots/[slotId]/submit/route.test.ts
//
// Real-database integration tests for POST /api/campaigns/slots/[slotId]/submit.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only Clerk is faked. Prisma is real. No mocked DB.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, MilestoneTier, SlotStatus, SocialPlatform, Prisma } from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';

// ---------------------------------------------------------------------------
// Mock Clerk auth and ensureUserProvisioned BEFORE importing the route handler.
// vitest hoists vi.mock calls, so this runs before any imports below.
// ---------------------------------------------------------------------------

const MOCK_CLERK_USER_ID = 'clerk_test_submit_abc123';
const MOCK_OTHER_CLERK_USER_ID = 'clerk_test_submit_xyz789';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn().mockResolvedValue({ userId: 'clerk_test_submit_abc123', sessionClaims: null }),
}));

vi.mock('@/lib/auth/ensure-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/ensure-user')>();
  return {
    ...actual,
    ensureUserProvisioned: vi.fn().mockResolvedValue({ ok: true, userId: MOCK_CLERK_USER_ID, created: false }),
  };
});

// Import auth after mocking it, matching approve/route.test.ts pattern
import { auth } from '@clerk/nextjs/server';

// Now import the route handler (POST function) after mocks are in place.
const { POST } = await import('./route');

// ---------------------------------------------------------------------------
// DB setup — must come before describeIf because beforeAll references prisma
// ---------------------------------------------------------------------------

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (RUN_DB_TESTS && !TEST_DATABASE_URL) {
  throw new Error(
    '[submit-route.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.',
  );
}

if (RUN_DB_TESTS && TEST_DATABASE_URL) {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `[submit-route.test] Refusing to run: database name "${dbName}" does not end in _test. ` +
        'Set TEST_DATABASE_URL to a _test database (e.g. socialbucks_test).',
    );
  }
}

let prisma: PrismaClient;

if (RUN_DB_TESTS && TEST_DATABASE_URL) {
  const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
  prisma = new PrismaClient({ adapter });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface SlotFixture {
  orgId: string;
  userId: string;
  creatorId: string;
  campaignId: string;
  socialAccountId: string;
  slotId: string;
}

async function createSlotFixture(
  db: PrismaClient,
  overrides: {
    platform?: SocialPlatform;
    status?: SlotStatus;
    escrowAmount?: string;
    noSocialAccount?: boolean;
  } = {},
): Promise<SlotFixture> {
  const suffix = Math.random().toString(36).slice(2, 8);

  const user = await db.user.create({
    data: {
      clerkId: `clerk_test_${suffix}`,
      email: `test_${suffix}@example.com`,
    },
    select: { id: true, clerkId: true },
  });

  // Per the approve route fix: auth() returns clerkId (string), not user.id (UUID).
  // This fixture's creator must match the mocked authenticated user.
  vi.mocked(auth).mockResolvedValue({ userId: user.clerkId, sessionClaims: null } as never);

  const org = await db.organization.create({
    data: { name: `Test Org ${suffix}` },
    select: { id: true },
  });

  const creator = await db.creator.create({
    data: { userId: user.id },
    select: { id: true },
  });

  // Allow tests to skip SA creation so they can assert "no active account"
  // without needing to delete a row the fixture just created.
  let saId = '';
  if (!overrides.noSocialAccount) {
    const sa = await db.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: overrides.platform ?? SocialPlatform.YOUTUBE,
        externalId: `ext_${suffix}`,
        tokenCiphertext: `v1.fake_iv.fake_tag.fake_ct_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        revokedAt: null,
      },
      select: { id: true },
    });
    saId = sa.id;
  }

  const campaign = await db.campaign.create({
    data: {
      organizationId: org.id,
      title: `Test Campaign ${suffix}`,
      totalBudget: new Prisma.Decimal(overrides.escrowAmount ?? '1000.00'),
      currency: 'USD',
    },
    select: { id: true },
  });

  const slot = await db.campaignCreatorSlot.create({
    data: {
      campaignId: campaign.id,
      creatorId: creator.id,
      status: overrides.status ?? SlotStatus.ACCEPTED,
      escrowAmount: new Prisma.Decimal(overrides.escrowAmount ?? '1000.00'),
      currentTier: MilestoneTier.BASELINE,
      platform: overrides.platform ?? SocialPlatform.YOUTUBE,
      isShort: true,
      viewTarget: 100000,
    },
    select: { id: true },
  });

  return {
    orgId: org.id,
    userId: user.id,
    creatorId: creator.id,
    campaignId: campaign.id,
    socialAccountId: saId,
    slotId: slot.id,
  };
}

async function createOtherSlotFixture(db: PrismaClient): Promise<SlotFixture> {
  // Creates a slot owned by a DIFFERENT clerk user (MOCK_OTHER_CLERK_USER_ID)
  // so we can test the 403 ownership check.
  const suffix = Math.random().toString(36).slice(2, 8);

  const otherUser = await db.user.create({
    data: {
      clerkId: `${MOCK_OTHER_CLERK_USER_ID}_${suffix}`,
      email: `other_${suffix}@example.com`,
    },
    select: { id: true, clerkId: true },
  });

  const org = await db.organization.create({
    data: { name: `Test Org ${suffix}` },
    select: { id: true },
  });

  const creator = await db.creator.create({
    data: { userId: otherUser.id },
    select: { id: true },
  });

  const sa = await db.socialAccount.create({
    data: {
      creatorId: creator.id,
      platform: SocialPlatform.YOUTUBE,
      externalId: `ext_other_${suffix}`,
      tokenCiphertext: `v1.fake_iv.fake_tag.fake_ct_${suffix}`,
      scopes: ['yt-analytics.readonly'],
      revokedAt: null,
    },
    select: { id: true },
  });

  const campaign = await db.campaign.create({
    data: {
      organizationId: org.id,
      title: `Test Campaign ${suffix}`,
      totalBudget: new Prisma.Decimal('1000.00'),
      currency: 'USD',
    },
    select: { id: true },
  });

  const slot = await db.campaignCreatorSlot.create({
    data: {
      campaignId: campaign.id,
      creatorId: creator.id,
      status: SlotStatus.ACCEPTED,
      escrowAmount: new Prisma.Decimal('1000.00'),
      currentTier: MilestoneTier.BASELINE,
      platform: SocialPlatform.YOUTUBE,
      isShort: true,
      viewTarget: 100000,
    },
    select: { id: true },
  });

  // Per STEP 2: this fixture creates a slot owned by otherUser, but we want to
  // authenticate as the MOCKED CLERK user to test the 403 ownership check.
  // Override auth to return MOCK_CLERK_USER_ID so the authenticated request
  // differs from the slot's real creator.
  vi.mocked(auth).mockResolvedValue({ userId: MOCK_CLERK_USER_ID, sessionClaims: null } as never);

  return {
    orgId: org.id,
    userId: otherUser.id,
    creatorId: creator.id,
    campaignId: campaign.id,
    socialAccountId: sa.id,
    slotId: slot.id,
  };
}

async function cleanSlotFixture(db: PrismaClient, f: SlotFixture): Promise<void> {
  await db.payoutEvent.deleteMany({ where: { slotId: f.slotId } });
  await db.campaignCreatorSlot.deleteMany({ where: { id: f.slotId } });
  await db.campaign.deleteMany({ where: { id: f.campaignId } });
  await db.socialAccount.deleteMany({ where: { id: f.socialAccountId } });
  await db.creator.deleteMany({ where: { id: f.creatorId } });
  await db.user.deleteMany({ where: { id: f.userId } });
  await db.organization.deleteMany({ where: { id: f.orgId } });
}

// ---------------------------------------------------------------------------
// Helper to call the route handler with a Request object
// ---------------------------------------------------------------------------

function makeRequest(
  slotId: string,
  contentUrl: string,
): Request {
  const body = JSON.stringify({ contentUrl });
  return new Request(`http://localhost/api/campaigns/slots/${slotId}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

describeIf(RUN_DB_TESTS)('POST /api/campaigns/slots/[slotId]/submit — real DB', () => {
  beforeAll(async () => {
    if (!prisma) return;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `[submit-route.test] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Happy path on every supported URL shape
  // -------------------------------------------------------------------------

  const contentUrlCases = [
    {
      label: 'YouTube Shorts',
      url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      platform: SocialPlatform.YOUTUBE,
      contentId: 'dQw4w9WgXcQ',
    },
    {
      label: 'YouTube watch',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      platform: SocialPlatform.YOUTUBE,
      contentId: 'dQw4w9WgXcQ',
    },
    {
      label: 'YouTube youtu.be',
      url: 'https://youtu.be/dQw4w9WgXcQ',
      platform: SocialPlatform.YOUTUBE,
      contentId: 'dQw4w9WgXcQ',
    },
    {
      label: 'Instagram post',
      url: 'https://www.instagram.com/p/C8q1xL9sK7a/',
      platform: SocialPlatform.INSTAGRAM,
      contentId: 'C8q1xL9sK7a',
    },
    {
      label: 'Instagram reel',
      url: 'https://www.instagram.com/reel/C8q1xL9sK7a/',
      platform: SocialPlatform.INSTAGRAM,
      contentId: 'C8q1xL9sK7a',
    },
  ];

  contentUrlCases.forEach(({ label, url, platform, contentId }) => {
    it(`happy path: ${label} URL -> 200 with parsed platform/contentId`, async () => {
      const f = await createSlotFixture(prisma, { platform });
      try {
        const req = makeRequest(f.slotId, url);
        const response = await POST(req, { params: Promise.resolve({ slotId: f.slotId }) });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
          id: f.slotId,
          status: SlotStatus.CONTENT_SUBMITTED,
          platform,
          contentId,
          submittedAt: body.submittedAt,
        });

        const slot = await prisma.campaignCreatorSlot.findUnique({
          where: { id: f.slotId },
          select: {
            contentUrl: true,
            platform: true,
            contentId: true,
            socialAccountId: true,
            submittedAt: true,
            status: true,
          },
        });
        expect(slot).not.toBeNull();
        expect(slot!.contentUrl).toBe(url);
        expect(slot!.platform).toBe(platform);
        expect(slot!.contentId).toBe(contentId);
        expect(slot!.socialAccountId).toBe(f.socialAccountId);
        expect(slot!.submittedAt).toBeInstanceOf(Date);
        expect(slot!.status).toBe(SlotStatus.CONTENT_SUBMITTED);
      } finally {
        await cleanSlotFixture(prisma, f);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 403: slot belongs to a different creator (slot exists, but not mine)
  // -------------------------------------------------------------------------

  it('403 when slot belongs to another creator — slot unchanged', async () => {
    const f = await createOtherSlotFixture(prisma);
    try {
      const req = makeRequest(f.slotId, 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
      const response = await POST(req, { params: Promise.resolve({ slotId: f.slotId }) });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Forbidden');

      const slot = await prisma.campaignCreatorSlot.findUnique({
        where: { id: f.slotId },
        select: { status: true, contentId: true },
      });
      expect(slot!.status).toBe(SlotStatus.ACCEPTED);
      expect(slot!.contentId).toBeNull();
    } finally {
      await cleanSlotFixture(prisma, f);
    }
  });

  // -------------------------------------------------------------------------
  // 409: slot not in ACCEPTED state
  // -------------------------------------------------------------------------

  const nonAcceptedStates: SlotStatus[] = [
    SlotStatus.INVITED,
    SlotStatus.CONTENT_SUBMITTED,
    SlotStatus.CONTENT_APPROVED,
  ];

  nonAcceptedStates.forEach((badStatus) => {
    it(`409 when slot is ${badStatus} (not ACCEPTED) — slot unchanged`, async () => {
      const f = await createSlotFixture(prisma, { status: badStatus });
      try {
        const req = makeRequest(f.slotId, 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
        const response = await POST(req, { params: Promise.resolve({ slotId: f.slotId }) });
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.error).toBe('Slot not in accepted state');
        expect(body.currentStatus).toBe(badStatus);

        const slot = await prisma.campaignCreatorSlot.findUnique({
          where: { id: f.slotId },
          select: { status: true, contentUrl: true },
        });
        expect(slot!.status).toBe(badStatus);
        expect(slot!.contentUrl).toBeNull();
      } finally {
        await cleanSlotFixture(prisma, f);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 409: no active social account for the parsed platform
  // -------------------------------------------------------------------------

  it('409 when creator has no active account for parsed platform — slot unchanged', async () => {
    // noSocialAccount:true means the fixture creates no SA at all, so the route
    // correctly finds nothing for YOUTUBE and returns 409.
    const f = await createSlotFixture(prisma, {
      platform: SocialPlatform.YOUTUBE,
      noSocialAccount: true,
    });
    try {
      const req = makeRequest(f.slotId, 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
      const response = await POST(req, { params: Promise.resolve({ slotId: f.slotId }) });
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('No active social account for platform');
      expect(body.platform).toBe(SocialPlatform.YOUTUBE);
      expect(body.message).toContain('Connect your youtube account first');

      const slot = await prisma.campaignCreatorSlot.findUnique({
        where: { id: f.slotId },
        select: { status: true, socialAccountId: true },
      });
      expect(slot!.status).toBe(SlotStatus.ACCEPTED);
      expect(slot!.socialAccountId).toBeNull();
    } finally {
      await cleanSlotFixture(prisma, f);
    }
  });

  // -------------------------------------------------------------------------
  // 400: malformed / unsupported URL
  // -------------------------------------------------------------------------

  const invalidUrls = [
    { url: 'https://www.tiktok.com/@user/video/1234567890', expectedError: 'Unsupported or malformed content URL' },
    { url: 'https://www.youtube.com/watch?v=shortid', expectedError: 'Unsupported or malformed content URL' }, // 10 chars
    { url: 'https://www.youtube.com/shorts/longerthan11chars1', expectedError: 'Unsupported or malformed content URL' },
    { url: 'https://www.instagram.com/p/ab/', expectedError: 'Unsupported or malformed content URL' }, // 2 chars — below the 5-char minimum
    { url: 'not-a-url', expectedError: 'Unsupported or malformed content URL' },
    { url: '', expectedError: 'Invalid request body' }, // empty string fails the body schema before parseContentUrl ever runs
    { url: 'https://example.com/foo/bar', expectedError: 'Unsupported or malformed content URL' },
  ];

  invalidUrls.forEach(({ url: badUrl, expectedError }) => {
    it(`400 for invalid URL: ${badUrl || '(empty)'}`, async () => {
      const f = await createSlotFixture(prisma);
      try {
        const req = makeRequest(f.slotId, badUrl);
        const response = await POST(req, { params: Promise.resolve({ slotId: f.slotId }) });
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toBe(expectedError);

        const slot = await prisma.campaignCreatorSlot.findUnique({
          where: { id: f.slotId },
          select: { status: true },
        });
        expect(slot!.status).toBe(SlotStatus.ACCEPTED);
      } finally {
        await cleanSlotFixture(prisma, f);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent submission — exactly one winner (compare-and-swap)
  // -------------------------------------------------------------------------

  it('two concurrent submits -> exactly one 200, other 409, slot consistent', async () => {
    const f = await createSlotFixture(prisma);
    try {
      const urls = [
        'https://www.youtube.com/shorts/dQw4w9WgXcQ',
        'https://youtu.be/aB3cD4eF5gH',
      ];

      // Fire two concurrent POST requests to the handler.
      const [r1, r2] = await Promise.all(
        urls.map((url) => POST(makeRequest(f.slotId, url), { params: Promise.resolve({ slotId: f.slotId }) })),
      );

      const [body1, body2] = await Promise.all([r1.json(), r2.json()]);
      const statuses = [r1.status, r2.status].sort();

      // Exactly one 200, one 409
      expect(statuses).toEqual([200, 409]);

      // The winner's values are consistent (no mix of both requests)
      const winnerBody = r1.status === 200 ? body1 : body2;
      expect(winnerBody.status).toBe(SlotStatus.CONTENT_SUBMITTED);
      expect(winnerBody.platform).toBe(SocialPlatform.YOUTUBE);

      // Verify the slot has exactly one set of values (the winner's)
      const slot = await prisma.campaignCreatorSlot.findUnique({
        where: { id: f.slotId },
        select: {
          contentUrl: true,
          platform: true,
          contentId: true,
          socialAccountId: true,
          submittedAt: true,
        },
      });
      expect(slot!.platform).toBe(SocialPlatform.YOUTUBE);
      expect(slot!.socialAccountId).toBe(f.socialAccountId);
      expect(slot!.submittedAt).toBeInstanceOf(Date);

      // The contentUrl/contentId must match one of the two URLs exactly,
      // not a blend. Since both URLs are YouTube, contentId should be 11 chars.
      expect(slot!.contentId).toMatch(/^[a-zA-Z0-9_-]{11}$/);
      expect(urls).toContain(slot!.contentUrl);
    } finally {
      await cleanSlotFixture(prisma, f);
    }
  });

  // -------------------------------------------------------------------------
  // 404: unknown slot
  // -------------------------------------------------------------------------

  it('404 when slotId does not exist', async () => {
    const req = makeRequest('does-not-exist-123456', 'https://www.youtube.com/shorts/dQw4w9WgXcQ');
    const response = await POST(req, { params: Promise.resolve({ slotId: 'does-not-exist-123456' }) });
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error).toBe('Slot not found');
  });

  // -------------------------------------------------------------------------
  // Validation: body must contain a string contentUrl
  // -------------------------------------------------------------------------

  it('400 when body lacks contentUrl', async () => {
    const f = await createSlotFixture(prisma);
    try {
      const req = new Request(`http://localhost/api/campaigns/slots/${f.slotId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(req, { params: Promise.resolve({ slotId: f.slotId }) });
      expect(response.status).toBe(400);
    } finally {
      await cleanSlotFixture(prisma, f);
    }
  });
});