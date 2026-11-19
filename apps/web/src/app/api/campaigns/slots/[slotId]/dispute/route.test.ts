// apps/web/src/app/api/campaigns/slots/[slotId]/dispute/route.test.ts
//
// Real-database integration tests for POST /api/campaigns/slots/[slotId]/dispute
// (ADR-0004 D3: IN_PROGRESS -> DISPUTED by org OWNER or ADMIN).
//
// REQUIRES RUN_DB_TESTS=1 and a reachable Postgres at TEST_DATABASE_URL.
// If the DB is unreachable, the suite FAILS LOUDLY — it never silently skips.
//
// Only Clerk auth is mocked for the route itself. Prisma is real and nothing
// about the database is faked.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignStatus,
  Prisma,
  PrismaClient,
  MilestoneTier,
  SlotStatus,
  SocialPlatform,
} from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';

// Auth identity is chosen per request: `pending` is consumed synchronously by
// the handler's first `await auth()`, so two requests started in one
// Promise.all keep their own identity even though the mock is shared.
const authState = vi.hoisted(() => ({
  defaultUserId: null as string | null,
  pending: [] as (string | null)[],
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({
    userId:
      authState.pending.length > 0
        ? authState.pending.shift()!
        : authState.defaultUserId,
    sessionClaims: null,
  })),
}));

import { POST as disputeSlot } from './route';
import { resetTestDatabase } from '@/test/reset-test-db';
import {
  settleSlot,
  type MetricsProvider,
} from '@/lib/settlement/settle-slot';
import { baselineAmount } from '@/lib/settlement/tiers';
import { fromMinorUnits, toMinorUnits } from '@/lib/settlement/money';
import { MAX_DISPUTE_REASON_LENGTH } from '@/lib/slots/dispute-schemas';

const DAY_MS = 24 * 60 * 60 * 1000;

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn('RUN_DB_TESTS != 1 — dispute route tests are SKIPPED, not passing.');
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

// Fake MetricsProvider that returns a configurable engagedViews count.
function makeFakeMetrics(billableViews: number): MetricsProvider {
  return {
    async fetchMetrics() {
      return {
        billableViews,
        billableMetric: 'engagedViews',
        settlementSnapshot: { fake: true, billableViews },
      };
    },
  };
}

describeDb('POST /api/campaigns/slots/[slotId]/dispute', () => {
  if (process.env.RUN_DB_TESTS === '1' && !process.env.TEST_DATABASE_URL) {
    throw new Error('RUN_DB_TESTS=1 but TEST_DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    authState.defaultUserId = null;
    authState.pending.length = 0;
    await resetTestDatabase(prisma);
  });

  // -------------------------------------------------------------------------
  // seedScenario
  // -------------------------------------------------------------------------

  interface SeedOptions {
    callerRole?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'NONE';
    callerIsCreator?: boolean;
    orgDeleted?: boolean;
    campaignStatus?: CampaignStatus;
    campaignDeleted?: boolean;
    slotStatus?: SlotStatus;
    slotDeleted?: boolean;
    escrowAmount?: string;
    viewTarget?: number;
    approvedAt?: Date | null;
    settlementEndsAt?: Date | null;
    paidToDate?: string;
    currentTier?: MilestoneTier | null;
    disputedAt?: Date | null;
    disputeReason?: string | null;
    disputeRaisedByUserId?: string | null;
    disputeResolvedAt?: Date | null;
    closedAt?: Date | null;
    /** Seed exactly one BASELINE PayoutEvent (as if approval already paid it). */
    seedBaseline?: boolean;
  }

  interface SeedResult {
    callerClerkId: string;
    callerUserId: string;
    creatorClerkId: string;
    creatorUserId: string;
    slotId: string;
    organizationId: string;
    campaignId: string;
    creatorId: string;
  }

  async function seedScenario(options: SeedOptions = {}): Promise<SeedResult> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const callerRole = options.callerRole ?? 'OWNER';

    const org = await prisma.organization.create({
      data: {
        name: `Dispute Org ${suffix}`,
        deletedAt: options.orgDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    const callerUser = await prisma.user.create({
      data: {
        clerkId: `clerk_dispute_caller_${suffix}`,
        email: `caller_${suffix}@test.local`,
      },
      select: { id: true, clerkId: true },
    });

    if (callerRole !== 'NONE') {
      await prisma.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: callerUser.id,
          role: callerRole,
        },
      });
    }

    const creatorUser = options.callerIsCreator
      ? callerUser
      : await prisma.user.create({
          data: {
            clerkId: `clerk_dispute_creator_${suffix}`,
            email: `creator_${suffix}@test.local`,
          },
          select: { id: true, clerkId: true },
        });

    const creator = await prisma.creator.create({
      data: { userId: creatorUser.id },
      select: { id: true },
    });

    const socialAccount = await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId: `ext_${suffix}`,
        handle: `handle_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake.${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });

    const escrowAmount = new Prisma.Decimal(options.escrowAmount ?? '1000.00');
    const approvedAt = options.approvedAt ?? new Date(Date.now() - 2 * DAY_MS);
    const settlementEndsAt = options.settlementEndsAt ?? new Date(Date.now() + 28 * DAY_MS);

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Dispute Campaign ${suffix}`,
        totalBudget: escrowAmount,
        currency: 'USD',
        status: options.campaignStatus ?? CampaignStatus.ACTIVE,
        submissionDeadline: new Date(Date.now() + 30 * DAY_MS),
        deletedAt: options.campaignDeleted ? new Date() : null,
      },
      select: { id: true },
    });

    const baseline = baselineAmount(escrowAmount);
    const paidToDate = options.paidToDate
      ? new Prisma.Decimal(options.paidToDate)
      : (options.seedBaseline ? baseline : new Prisma.Decimal('0.00'));
    const currentTier = options.currentTier !== undefined
      ? options.currentTier
      : (options.seedBaseline ? MilestoneTier.BASELINE : null);

    const isDisputed = (options.slotStatus ?? SlotStatus.IN_PROGRESS) === SlotStatus.DISPUTED;
    const isClosed = options.slotStatus === SlotStatus.CLOSED;

    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        escrowAmount,
        status: options.slotStatus ?? SlotStatus.IN_PROGRESS,
        viewTarget: options.viewTarget ?? 1000,
        metric: 'engagedViews',
        platform: SocialPlatform.YOUTUBE,
        contentId: `vid_${suffix}`,
        socialAccountId: socialAccount.id,
        isShort: true,
        isShortVerifiedAt: new Date(),
        approvedAt,
        settlementEndsAt,
        paidToDate,
        currentTier,
        invitedAt: new Date(),
        inviteExpiresAt: new Date(Date.now() + 7 * DAY_MS),
        deletedAt: options.slotDeleted ? new Date() : null,
        disputedAt: options.disputedAt !== undefined
          ? options.disputedAt
          : (isDisputed ? new Date() : null),
        disputeReason: options.disputeReason !== undefined
          ? options.disputeReason
          : (isDisputed ? 'Fixture dispute' : null),
        disputeRaisedByUserId: options.disputeRaisedByUserId !== undefined
          ? options.disputeRaisedByUserId
          : (isDisputed ? creatorUser.id : null),
        disputeResolvedAt: options.disputeResolvedAt ?? null,
        closedAt: options.closedAt !== undefined
          ? options.closedAt
          : (isClosed ? new Date() : null),
      },
      select: { id: true },
    });

    if (options.seedBaseline) {
      await prisma.payoutEvent.create({
        data: {
          slotId: slot.id,
          tier: MilestoneTier.BASELINE,
          amount: baseline,
          currency: 'USD',
          settlementJson: { kind: 'BASELINE_AT_APPROVAL' },
        },
      });
    }

    return {
      callerClerkId: callerUser.clerkId,
      callerUserId: callerUser.id,
      creatorClerkId: creatorUser.clerkId,
      creatorUserId: creatorUser.id,
      slotId: slot.id,
      organizationId: org.id,
      campaignId: campaign.id,
      creatorId: creator.id,
    };
  }

  // -------------------------------------------------------------------------
  // Request helpers
  // -------------------------------------------------------------------------

  function disputeRequest(slotId: string, init: { body?: string }): Promise<Response> {
    const requestInit: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    };
    if (init.body !== undefined) requestInit.body = init.body;
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/dispute`,
      requestInit,
    );
    return disputeSlot(req, { params: Promise.resolve({ slotId }) });
  }

  function disputeRaw(
    slotId: string,
    body: BodyInit,
    contentType?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (contentType !== undefined) headers['content-type'] = contentType;
    const req = new Request(
      `http://localhost/api/campaigns/slots/${slotId}/dispute`,
      { method: 'POST', headers, body },
    );
    return disputeSlot(req, { params: Promise.resolve({ slotId }) });
  }

  function callDispute(
    slotId: string,
    options: { as?: string | null; rawBody?: string } = {},
  ): Promise<Response> {
    // The push and the POST call happen in one synchronous block, so the
    // handler consumes exactly this identity.
    authState.pending.push(
      options.as === undefined ? authState.defaultUserId : options.as,
    );
    return disputeRequest(slotId, { body: options.rawBody });
  }

  async function snapshotSlot(slotId: string) {
    return prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: {
        status: true,
        paidToDate: true,
        currentTier: true,
        settlementEndsAt: true,
        approvedAt: true,
        disputedAt: true,
        disputeReason: true,
        disputeRaisedByUserId: true,
        disputeResolvedAt: true,
        closedAt: true,
      },
    });
  }

  async function snapshotEvents(slotId: string) {
    return prisma.payoutEvent.findMany({
      where: { slotId },
      orderBy: { tier: 'asc' },
    });
  }

  // =========================================================================
  // 1. Happy path: IN_PROGRESS -> DISPUTED
  // =========================================================================

  it('disputes an IN_PROGRESS slot and returns id, status and the stored disputedAt', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;
    const before = new Date();

    const res = await callDispute(f.slotId, {
      rawBody: JSON.stringify({ reason: 'The submitted content does not match the brief.' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as {
      id: string;
      status: SlotStatus;
      disputedAt: string | null;
    };

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.DISPUTED);
    expect(slot.disputedAt).not.toBeNull();
    expect(body).toEqual({
      id: f.slotId,
      status: SlotStatus.DISPUTED,
      disputedAt: slot.disputedAt!.toISOString(),
    });
    expect(slot.disputedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(slot.disputeReason).toBe('The submitted content does not match the brief.');
    expect(slot.disputeRaisedByUserId).toBe(f.callerUserId);
    expect(slot.disputeResolvedAt).toBeNull();
    expect(slot.closedAt).toBeNull();
  });

  // =========================================================================
  // 2. Money and clock untouched
  // =========================================================================

  it('leaves money, clock and ledger fields untouched apart from the status', async () => {
    const f = await seedScenario({
      seedBaseline: true,
      paidToDate: '250.00',
      currentTier: MilestoneTier.BASELINE,
    });
    authState.defaultUserId = f.callerClerkId;

    const before = await snapshotSlot(f.slotId);
    const beforeEvents = await snapshotEvents(f.slotId);
    expect(beforeEvents).toHaveLength(1);
    expect(beforeEvents[0]!.tier).toBe(MilestoneTier.BASELINE);

    expect(
      (await callDispute(f.slotId, { rawBody: JSON.stringify({ reason: 'x' }) })).status,
    ).toBe(200);

    const after = await snapshotSlot(f.slotId);
    const afterEvents = await snapshotEvents(f.slotId);

    expect(after.status).toBe(SlotStatus.DISPUTED);
    expect(after.paidToDate.toFixed(2)).toBe(before.paidToDate.toFixed(2));
    expect(after.currentTier).toBe(before.currentTier);
    expect(after.settlementEndsAt).toEqual(before.settlementEndsAt);
    expect(after.approvedAt).toEqual(before.approvedAt);
    expect(afterEvents).toEqual(beforeEvents);
    expect(afterEvents).toHaveLength(1);
    expect(afterEvents[0]!.tier).toBe(MilestoneTier.BASELINE);
  });

  // =========================================================================
  // 3. Re-dispute: previously disputed and resolved slot
  // =========================================================================

  it('re-disputes a previously resolved slot and replaces the dispute record', async () => {
    const earlierDisputedAt = new Date(Date.now() - 10 * DAY_MS);
    const earlierResolvedAt = new Date(Date.now() - 5 * DAY_MS);
    const f = await seedScenario({
      slotStatus: SlotStatus.IN_PROGRESS,
      disputedAt: earlierDisputedAt,
      disputeReason: 'Earlier dispute reason',
      disputeResolvedAt: earlierResolvedAt,
    });
    // The earlier dispute must name a real user (FK + CHECK).
    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { disputeRaisedByUserId: f.creatorUserId },
    });

    const before = new Date();
    authState.defaultUserId = f.callerClerkId;

    const res = await callDispute(f.slotId, {
      rawBody: JSON.stringify({ reason: 'The issue came back after resolution.' }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { id: string; status: SlotStatus; disputedAt: string | null };
    expect(body.status).toBe(SlotStatus.DISPUTED);
    expect(body.disputedAt).not.toBe(earlierDisputedAt.toISOString());

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.DISPUTED);
    expect(slot.disputedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(slot.disputedAt!.getTime()).toBeGreaterThan(earlierDisputedAt.getTime());
    expect(slot.disputeReason).toBe('The issue came back after resolution.');
    expect(slot.disputeRaisedByUserId).toBe(f.callerUserId);
    // The new dispute is not yet resolved.
    expect(slot.disputeResolvedAt).toBeNull();
  });

  // =========================================================================
  // 4. Reason handling
  // =========================================================================

  const ACCEPTED_REASONS: [string, string, string][] = [
    ['leading/trailing whitespace trimmed', '  The content is wrong  ', 'The content is wrong'],
    ['NFD stored as NFC', '\u0065\u0301', '\u00e9'], // e + combining acute -> NFC
    ['1000-character reason accepted', 'a'.repeat(1000), 'a'.repeat(1000)],
    ['newlines allowed', 'line one\nline two', 'line one\nline two'],
    ['tabs allowed', 'a\tb\tc', 'a\tb\tc'],
  ];

  it.each(ACCEPTED_REASONS)(
    'accepts %s and stores it normalized',
    async (_label, inputReason, expectedStored) => {
      const f = await seedScenario();
      authState.defaultUserId = f.callerClerkId;

      const res = await callDispute(f.slotId, {
        rawBody: JSON.stringify({ reason: inputReason }),
      });
      expect(res.status).toBe(200);

      const slot = await snapshotSlot(f.slotId);
      expect(slot.disputeReason).toBe(expectedStored);
      expect(slot.disputeReason!.length).toBeGreaterThan(0);
    },
  );

  const REJECTED_REASONS: [string, Record<string, unknown>, string | undefined][] = [
    ['empty reason', { reason: '' }, undefined],
    ['whitespace-only reason', { reason: '   \n\t ' }, undefined],
    ['1001-character reason', { reason: 'a'.repeat(1001) }, 'a'.repeat(1001)],
    ['control character', { reason: 'x\u0000y' }, 'x\u0000y'],
    ['bidi override', { reason: 'x\u202Ey' }, 'x\u202Ey'],
    [
      'extra key in body',
      { reason: 'Valid reason', extra: 'CANARY_9f3c1d' },
      'CANARY_9f3c1d',
    ],
    ['missing reason', {}, undefined],
    ['non-string reason', { reason: 5 }, undefined],
  ];

  it.each(REJECTED_REASONS)(
    'rejects %s with 400, slot unchanged and response never echoes submitted text',
    async (_label, body, submittedText) => {
      const f = await seedScenario();
      authState.defaultUserId = f.callerClerkId;

      const res = await callDispute(f.slotId, { rawBody: JSON.stringify(body) });
      expect(res.status).toBe(400);

      const text = await res.text();
      const parsed = JSON.parse(text) as { error: string; issues: unknown[] };
      expect(parsed.error).toBe('Invalid request');
      expect(Array.isArray(parsed.issues)).toBe(true);
      if (submittedText) {
        expect(text).not.toContain(submittedText);
      }

      const slot = await snapshotSlot(f.slotId);
      expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
      expect(slot.disputedAt).toBeNull();
      expect(slot.disputeReason).toBeNull();
      expect(slot.disputeRaisedByUserId).toBeNull();
      expect(slot.disputeResolvedAt).toBeNull();
      expect(slot.closedAt).toBeNull();
      const events = await snapshotEvents(f.slotId);
      expect(events).toHaveLength(0);
    },
  );

  // =========================================================================
  // 5. Body transport
  // =========================================================================

  it('rejects wrong Content-Type with 415', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const res = await disputeRaw(
      f.slotId,
      JSON.stringify({ reason: 'x' }),
      'text/plain',
    );
    expect(res.status).toBe(415);

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
  });

  it('rejects missing Content-Type with 415', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const res = await disputeRaw(f.slotId, JSON.stringify({ reason: 'x' }));
    expect(res.status).toBe(415);

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
  });

  it('rejects invalid JSON with 400', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const res = await disputeRaw(f.slotId, '{not json', 'application/json');
    expect(res.status).toBe(400);

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
  });

  it('rejects invalid UTF-8 bytes with 400', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const invalidUtf8 = new Uint8Array([0xC3, 0x28]);
    const res = await disputeRaw(f.slotId, invalidUtf8, 'application/json');
    expect(res.status).toBe(400);

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
  });

  it('rejects a body over 16 KB with 413', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const oversized = JSON.stringify({ reason: 'x'.repeat(20_000) });
    const res = await disputeRaw(f.slotId, oversized, 'application/json');
    expect(res.status).toBe(413);

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
  });

  // =========================================================================
  // 6. Authorization comes before the body
  // =========================================================================

  it('non-member + invalid body -> 404, never 400', async () => {
    const f = await seedScenario({ callerRole: 'NONE' });
    authState.defaultUserId = f.callerClerkId;

    const res = await callDispute(f.slotId, { rawBody: '{not json' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('MEMBER + invalid body -> 403, never 400', async () => {
    const f = await seedScenario({ callerRole: 'MEMBER' });
    authState.defaultUserId = f.callerClerkId;

    const res = await callDispute(f.slotId, { rawBody: '{not json' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('creator who manages the org + invalid body -> 403 SELF_ACTION_NOT_ALLOWED', async () => {
    const f = await seedScenario({ callerRole: 'OWNER', callerIsCreator: true });
    authState.defaultUserId = f.callerClerkId;

    const res = await callDispute(f.slotId, { rawBody: '{not json' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You cannot dispute your own slot',
      code: 'SELF_ACTION_NOT_ALLOWED',
    });
  });

  it('unauthenticated -> 401', async () => {
    const f = await seedScenario();
    authState.defaultUserId = null;

    const res = await callDispute(f.slotId, { rawBody: '{not json' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  // =========================================================================
  // 7. Uniform 404s
  // =========================================================================

  interface NotFoundCase {
    name: string;
    seed: () => Promise<SeedResult>;
    callId: (f: SeedResult) => string;
  }

  const NOT_FOUND_CASES: NotFoundCase[] = [
    {
      name: 'a non-member caller',
      seed: () => seedScenario({ callerRole: 'NONE' }),
      callId: (f) => f.slotId,
    },
    {
      name: 'an unknown slot id',
      seed: () => seedScenario(),
      callId: () => 'slot_does_not_exist',
    },
    {
      name: 'a malformed slot id',
      seed: () => seedScenario(),
      callId: () => '../x',
    },
    {
      name: 'a soft-deleted slot',
      seed: () => seedScenario({ slotDeleted: true }),
      callId: (f) => f.slotId,
    },
    {
      name: 'a soft-deleted campaign',
      seed: () => seedScenario({ campaignDeleted: true }),
      callId: (f) => f.slotId,
    },
    {
      name: 'a member of a soft-deleted organization',
      seed: () => seedScenario({ orgDeleted: true, callerRole: 'OWNER' }),
      callId: (f) => f.slotId,
    },
  ];

  it.each(NOT_FOUND_CASES)(
    'returns 404 Not found for $name and changes nothing',
    async ({ seed, callId }) => {
      const f = await seed();
      authState.defaultUserId = f.callerClerkId;

      const res = await callDispute(callId(f), { rawBody: JSON.stringify({ reason: 'x' }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });

      const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: f.slotId },
      });
      expect(slot.status).toBe(SlotStatus.IN_PROGRESS);
      expect(slot.disputedAt).toBeNull();
    },
  );

  it('all six 404 bodies are byte-identical', async () => {
    const serialized: string[] = [];

    for (const scenario of NOT_FOUND_CASES) {
      const f = await scenario.seed();
      authState.defaultUserId = f.callerClerkId;
      const res = await callDispute(scenario.callId(f), { rawBody: JSON.stringify({ reason: 'x' }) });
      expect(res.status).toBe(404);
      serialized.push(await res.text());
    }

    expect(new Set(serialized).size).toBe(1);
    expect(JSON.parse(serialized[0]!)).toEqual({ error: 'Not found' });
  });

  // =========================================================================
  // 8. Every status except IN_PROGRESS -> 409
  // =========================================================================

  const NON_DISPUTABLE_STATUSES: SlotStatus[] = Object.values(SlotStatus).filter(
    (s) => s !== SlotStatus.IN_PROGRESS,
  );

  it.each(NON_DISPUTABLE_STATUSES)(
    'rejects a %s slot with 409 SLOT_NOT_DISPUTABLE and changes nothing',
    async (status) => {
      const f = await seedScenario({ slotStatus: status });
      authState.defaultUserId = f.callerClerkId;

      const before = await snapshotSlot(f.slotId);

      const res = await callDispute(f.slotId, { rawBody: JSON.stringify({ reason: 'x' }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Slot cannot be disputed in its current state',
        code: 'SLOT_NOT_DISPUTABLE',
      });

      const after = await snapshotSlot(f.slotId);
      expect(after.status).toBe(status);
      expect(after.disputedAt).toEqual(before.disputedAt);
      expect(after.disputeReason).toEqual(before.disputeReason);
      expect(after.disputeRaisedByUserId).toEqual(before.disputeRaisedByUserId);
      expect(after.disputeResolvedAt).toEqual(before.disputeResolvedAt);
      expect(after.closedAt).toEqual(before.closedAt);
    },
  );

  // =========================================================================
  // 9. Campaign state is not a precondition
  // =========================================================================

  it.each(Object.values(CampaignStatus))(
    'disputes an IN_PROGRESS slot even when the campaign is %s',
    async (campaignStatus) => {
      const f = await seedScenario({ campaignStatus });
      authState.defaultUserId = f.callerClerkId;

      const res = await callDispute(f.slotId, { rawBody: JSON.stringify({ reason: 'x' }) });
      expect(res.status).toBe(200);

      const slot = await snapshotSlot(f.slotId);
      expect(slot.status).toBe(SlotStatus.DISPUTED);
    },
  );

  // =========================================================================
  // 10. Concurrency
  // =========================================================================

  it('5 parallel disputes give exactly one 200, the rest 409, and the stored disputedAt equals the winner', async () => {
    const f = await seedScenario();
    authState.defaultUserId = f.callerClerkId;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        callDispute(f.slotId, { rawBody: JSON.stringify({ reason: 'r' }) }),
      ),
    );
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409, 409, 409, 409]);

    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const winnerBody = (await winners[0]!.json()) as { disputedAt: string };

    const slot = await snapshotSlot(f.slotId);
    expect(slot.status).toBe(SlotStatus.DISPUTED);
    expect(slot.disputedAt).not.toBeNull();
    expect(winnerBody.disputedAt).toBe(slot.disputedAt!.toISOString());
  });

  it('dispute vs settleSlot, 10 rounds: dispute always wins with 200, ledger never duplicates a tier', async () => {
    for (let round = 0; round < 10; round++) {
      const f = await seedScenario({
        slotStatus: SlotStatus.IN_PROGRESS,
        seedBaseline: true,
        viewTarget: 1000,
      });
      authState.defaultUserId = f.callerClerkId;
      const fakeMetrics = makeFakeMetrics(500); // reaches TIER_40 only

      const [disputeRes, settleRes] = await Promise.all([
        callDispute(f.slotId, { rawBody: JSON.stringify({ reason: 'race reason' }) }),
        settleSlot(f.slotId, prisma, fakeMetrics),
      ]);

      expect(disputeRes.status).toBe(200);

      // settleSlot either advanced TIER_40 or skipped because the slot became DISPUTED.
      if (settleRes.status === 'ADVANCED') {
        expect(settleRes.newTiers).toEqual([MilestoneTier.TIER_40]);
      } else {
        expect(settleRes).toEqual({
          status: 'SKIPPED_NOT_ELIGIBLE',
          reason: 'slot_not_in_progress',
        });
      }

      const finalSlot = await snapshotSlot(f.slotId);
      expect(finalSlot.status).toBe(SlotStatus.DISPUTED);

      const events = await snapshotEvents(f.slotId);
      const tier40Count = events.filter((e) => e.tier === MilestoneTier.TIER_40).length;
      const baselineCount = events.filter((e) => e.tier === MilestoneTier.BASELINE).length;
      expect(baselineCount).toBe(1);
      expect(tier40Count).toBeLessThanOrEqual(1);
      expect(events.length).toBe(1 + tier40Count);

      // paidToDate equals the sum of the ledger amounts.
      const paidMinor = events.reduce((sum, e) => sum + toMinorUnits(e.amount), 0n);
      expect(finalSlot.paidToDate).toEqual(fromMinorUnits(paidMinor));

      // A settleSlot call after the dispute returns SKIPPED and writes nothing.
      const settledAfter = await settleSlot(f.slotId, prisma, fakeMetrics);
      expect(settledAfter).toEqual({
        status: 'SKIPPED_NOT_ELIGIBLE',
        reason: 'slot_not_in_progress',
      });

      const eventsAgain = await snapshotEvents(f.slotId);
      expect(eventsAgain).toEqual(events);
    }
  });

  // =========================================================================
  // 11. Freeze
  // =========================================================================

  it('freezes a slot whose metrics already exceed TIER_40', async () => {
    const f = await seedScenario({
      slotStatus: SlotStatus.IN_PROGRESS,
      seedBaseline: true,
      viewTarget: 1000,
    });
    authState.defaultUserId = f.callerClerkId;
    const fakeMetrics = makeFakeMetrics(500);

    // Settlement advances TIER_40 first.
    const first = await settleSlot(f.slotId, prisma, fakeMetrics);
    expect(first).toMatchObject({
      status: 'ADVANCED',
      newTiers: [MilestoneTier.TIER_40],
    });

    const beforeLedger = await snapshotEvents(f.slotId);
    const beforeSlot = await snapshotSlot(f.slotId);

    // Dispute flips the slot to DISPUTED.
    expect(
      (await callDispute(f.slotId, { rawBody: JSON.stringify({ reason: 'freeze' }) })).status,
    ).toBe(200);
    const afterDispute = await snapshotSlot(f.slotId);
    expect(afterDispute.status).toBe(SlotStatus.DISPUTED);

    // Settlement afterwards skips and writes nothing.
    const second = await settleSlot(f.slotId, prisma, fakeMetrics);
    expect(second).toEqual({
      status: 'SKIPPED_NOT_ELIGIBLE',
      reason: 'slot_not_in_progress',
    });

    const afterLedger = await snapshotEvents(f.slotId);
    const afterSlot = await snapshotSlot(f.slotId);
    expect(afterLedger).toEqual(beforeLedger);
    expect(afterSlot.paidToDate.toFixed(2)).toBe(beforeSlot.paidToDate.toFixed(2));
    expect(afterSlot.currentTier).toBe(beforeSlot.currentTier);
    expect(afterSlot.settlementEndsAt).toEqual(beforeSlot.settlementEndsAt);
    expect(afterSlot.approvedAt).toEqual(beforeSlot.approvedAt);
  });

  // =========================================================================
  // 12. MAX_DISPUTE_REASON_LENGTH stays in sync with the DB CHECK
  // =========================================================================

  it('MAX_DISPUTE_REASON_LENGTH is 1000', () => {
    expect(MAX_DISPUTE_REASON_LENGTH).toBe(1000);
  });

  it('DB CHECK accepts a 1000-char reason and rejects 1001 when written directly', async () => {
    const f = await seedScenario();
    const aThousand = 'a'.repeat(1000);
    const aThousandOne = 'a'.repeat(1001);

    await expect(
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: {
          status: SlotStatus.DISPUTED,
          disputedAt: new Date(),
          disputeReason: aThousand,
          disputeRaisedByUserId: f.callerUserId,
          disputeResolvedAt: null,
        },
      }),
    ).resolves.toBeDefined();

    await expect(
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: { disputeReason: aThousandOne },
      }),
    ).rejects.toThrow();
  });
});
