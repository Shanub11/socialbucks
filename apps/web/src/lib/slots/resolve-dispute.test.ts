// apps/web/src/lib/slots/resolve-dispute.test.ts
//
// Real-database integration tests for resolveDispute() (ADR-0004 D4).
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only the settlement MetricsProvider is faked. Prisma is real, no mocked DB.
// Every fixture stores a canary dispute reason, so any leak of it into a log
// line, a result object or a formatted message fails a test.
//
// Run: RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... vitest run resolve-dispute.test.ts

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CampaignStatus,
  MilestoneTier,
  Prisma,
  PrismaClient,
  SlotStatus,
  SocialPlatform,
} from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';

import { resetTestDatabase } from '@/test/reset-test-db';
import { settleSlot, type MetricsProvider } from '@/lib/settlement/settle-slot';
import {
  MAX_OPERATOR_LENGTH,
  resolveDispute,
  type ResolveDisputeInput,
} from './resolve-dispute';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — resolve-dispute tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const REASON_CANARY = 'CANARY_dispute_reason_4c1';
const OPERATOR = 'operator_alice';
const DISPUTED_AT = new Date('2026-02-01T00:00:00Z');
const WINDOW_ENDS_AT = new Date('2026-03-01T00:00:00Z');

describeDb('resolveDispute — real DB (ADR-0004 D4)', () => {
  if (process.env.RUN_DB_TESTS === '1' && !process.env.TEST_DATABASE_URL) {
    throw new Error('RUN_DB_TESTS=1 but TEST_DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
  });

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `[resolve-dispute] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTestDatabase(prisma);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Fixture
  // -------------------------------------------------------------------------

  interface SlotFixture {
    slotId: string;
    campaignId: string;
    organizationId: string;
    creatorId: string;
    creatorUserId: string;
    raiserUserId: string;
    socialAccountId: string;
    disputedAt: Date | null;
    settlementEndsAt: Date | null;
  }

  interface SlotOverrides {
    status?: SlotStatus;
    disputedAt?: Date | null;
    settlementEndsAt?: Date | null;
    escrowAmount?: string;
    paidToDate?: string;
    deletedAt?: Date | null;
  }

  async function createSlotFixture(
    overrides: SlotOverrides = {},
  ): Promise<SlotFixture> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const status = overrides.status ?? SlotStatus.DISPUTED;
    const disputedAt =
      overrides.disputedAt !== undefined ? overrides.disputedAt : DISPUTED_AT;
    const settlementEndsAt =
      overrides.settlementEndsAt !== undefined
        ? overrides.settlementEndsAt
        : WINDOW_ENDS_AT;

    const org = await prisma.organization.create({
      data: { name: `Resolve Org ${suffix}` },
      select: { id: true },
    });

    const raiser = await prisma.user.create({
      data: {
        clerkId: `clerk_resolve_raiser_${suffix}`,
        email: `resolve_raiser_${suffix}@test.local`,
      },
      select: { id: true },
    });

    const creatorUser = await prisma.user.create({
      data: {
        clerkId: `clerk_resolve_creator_${suffix}`,
        email: `resolve_creator_${suffix}@test.local`,
      },
      select: { id: true },
    });

    const creator = await prisma.creator.create({
      data: { userId: creatorUser.id },
      select: { id: true },
    });

    const socialAccount = await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId: `ext_resolve_${suffix}`,
        handle: `resolve_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake_resolve_${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Resolve Campaign ${suffix}`,
        totalBudget: new Prisma.Decimal('1000.00'),
        currency: 'USD',
        status: CampaignStatus.ACTIVE,
        submissionDeadline: new Date(Date.now() + 30 * DAY_MS),
      },
      select: { id: true },
    });

    // Inserting in the target state requires that state's record columns:
    // slot_disputed_requires_record, slot_closed_requires_closed_at and
    // slot_cancelled_requires_cancelled_at apply to INSERT as well.
    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        status,
        escrowAmount: new Prisma.Decimal(overrides.escrowAmount ?? '1000.00'),
        paidToDate: new Prisma.Decimal(overrides.paidToDate ?? '0.00'),
        viewTarget: 100000,
        metric: 'engagedViews',
        platform: SocialPlatform.YOUTUBE,
        contentId: `vid_resolve_${suffix}`,
        socialAccountId: socialAccount.id,
        isShort: true,
        invitedAt: new Date('2026-01-01T00:00:00Z'),
        approvedAt: new Date('2026-01-01T00:00:00Z'),
        settlementEndsAt,
        deletedAt: overrides.deletedAt ?? null,
        ...(status === SlotStatus.DISPUTED && disputedAt !== null
          ? {
              disputedAt,
              disputeReason: REASON_CANARY,
              disputeRaisedByUserId: raiser.id,
            }
          : {}),
        ...(status === SlotStatus.CLOSED
          ? { closedAt: new Date('2026-02-10T00:00:00Z') }
          : {}),
        ...(status === SlotStatus.CANCELLED
          ? { cancelledAt: new Date('2026-02-10T00:00:00Z') }
          : {}),
      },
      select: { id: true },
    });

    return {
      slotId: slot.id,
      campaignId: campaign.id,
      organizationId: org.id,
      creatorId: creator.id,
      creatorUserId: creatorUser.id,
      raiserUserId: raiser.id,
      socialAccountId: socialAccount.id,
      disputedAt,
      settlementEndsAt,
    };
  }

  async function readSlot(slotId: string) {
    return prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
    });
  }

  function captureInfo() {
    return vi.spyOn(console, 'info').mockImplementation(() => undefined);
  }

  async function payoutEventCount(slotId: string): Promise<number> {
    return prisma.payoutEvent.count({ where: { slotId } });
  }

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

  function makeExplodingMetrics(): {
    provider: MetricsProvider;
    wasCalled: () => boolean;
  } {
    let called = false;
    return {
      provider: {
        async fetchMetrics() {
          called = true;
          throw new Error(
            'metrics provider must not be called for an ineligible slot',
          );
        },
      },
      wasCalled: () => called,
    };
  }

  function input(
    slotId: string,
    overrides: Partial<ResolveDisputeInput> = {},
  ): ResolveDisputeInput {
    return {
      slotId,
      outcome: 'RESUME',
      operator: OPERATOR,
      apply: true,
      ...overrides,
    };
  }

  /** The reason must never appear in a result, a log line or an error. */
  function assertNoReasonLeak(value: unknown): void {
    const text = JSON.stringify(value);
    expect(text).not.toContain(REASON_CANARY);
    expect(text).not.toContain('disputeReason');
  }

  // =========================================================================
  // 1. Dry run: plans, never writes, never logs
  // =========================================================================

  describe('dry run', () => {
    it('plans a RESUME without writing or logging', async () => {
      const f = await createSlotFixture();
      const info = captureInfo();
      const now = new Date(f.disputedAt!.getTime() + 2 * HOUR_MS);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { now, apply: false }),
      );

      expect(result.kind).toBe('planned');
      if (result.kind !== 'planned') throw new Error('expected a plan');
      expect(result.outcome).toBe('RESUME');
      expect(result.newStatus).toBe('IN_PROGRESS');
      expect(result.extensionMs).toBe(2 * HOUR_MS);
      expect(result.disputedAt).toBe(f.disputedAt!.toISOString());
      expect(result.resolvedAt).toBe(now.toISOString());
      expect(result.settlementEndsAt).toBe(WINDOW_ENDS_AT.toISOString());
      expect(result.newSettlementEndsAt).toBe(
        new Date(WINDOW_ENDS_AT.getTime() + 2 * HOUR_MS).toISOString(),
      );
      expect(result.escrowAmount).toBe('1000.00');
      expect(result.unreleasedAmount).toBe('1000.00');
      assertNoReasonLeak(result);

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.DISPUTED);
      expect(stored.settlementEndsAt).toEqual(WINDOW_ENDS_AT);
      expect(stored.disputeResolvedAt).toBeNull();
      expect(stored.closedAt).toBeNull();
      expect(await payoutEventCount(f.slotId)).toBe(0);
      expect(info).not.toHaveBeenCalled();
    });

    it('plans a CLOSE without writing or logging', async () => {
      const f = await createSlotFixture({ paidToDate: '250.00' });
      const info = captureInfo();
      const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { outcome: 'CLOSE', now, apply: false }),
      );

      expect(result.kind).toBe('planned');
      if (result.kind !== 'planned') throw new Error('expected a plan');
      expect(result.outcome).toBe('CLOSE');
      expect(result.newStatus).toBe('CLOSED');
      expect(result.newSettlementEndsAt).toBeNull();
      expect(result.extensionMs).toBeNull();
      expect(result.unreleasedAmount).toBe('750.00');
      assertNoReasonLeak(result);

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.DISPUTED);
      expect(stored.closedAt).toBeNull();
      expect(stored.disputeResolvedAt).toBeNull();
      expect(await payoutEventCount(f.slotId)).toBe(0);
      expect(info).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Apply RESUME
  // =========================================================================

  describe('RESUME', () => {
    it('extends the window by exactly the disputed time and logs the operator', async () => {
      const f = await createSlotFixture();
      const info = captureInfo();
      const extension = 3 * HOUR_MS + 1_500;
      const now = new Date(f.disputedAt!.getTime() + extension);

      const result = await resolveDispute(prisma, input(f.slotId, { now }));

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected an apply');
      expect(result.newStatus).toBe('IN_PROGRESS');
      expect(result.extensionMs).toBe(extension);
      expect(result.resolvedAt).toBe(now.toISOString());
      expect(result.operator).toBe(OPERATOR);
      assertNoReasonLeak(result);

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.IN_PROGRESS);
      expect(stored.disputeResolvedAt).toEqual(now);
      expect(stored.closedAt).toBeNull();
      expect(stored.disputedAt).toEqual(f.disputedAt);
      expect(stored.disputeReason).toBe(REASON_CANARY);
      expect(stored.settlementEndsAt).toEqual(
        new Date(WINDOW_ENDS_AT.getTime() + extension),
      );
      // Resolution never moves money.
      expect(stored.escrowAmount.toFixed(2)).toBe('1000.00');
      expect(stored.paidToDate.toFixed(2)).toBe('0.00');
      expect(await payoutEventCount(f.slotId)).toBe(0);

      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('[slots] dispute resolved', {
        slotId: f.slotId,
        outcome: 'RESUME',
        operator: OPERATOR,
        resolvedAt: now.toISOString(),
      });
      assertNoReasonLeak(info.mock.calls);
    });

    it('defaults the resolution time to now', async () => {
      const f = await createSlotFixture();
      captureInfo();

      const before = Date.now();
      const result = await resolveDispute(prisma, input(f.slotId));
      const after = Date.now();

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected an apply');
      const resolved = new Date(result.resolvedAt).getTime();
      expect(resolved).toBeGreaterThanOrEqual(before);
      expect(resolved).toBeLessThanOrEqual(after);

      const stored = await readSlot(f.slotId);
      expect(stored.disputeResolvedAt?.getTime()).toBe(resolved);
      expect(stored.settlementEndsAt?.getTime()).toBe(
        WINDOW_ENDS_AT.getTime() + (resolved - f.disputedAt!.getTime()),
      );
    });

    it('normalizes the operator before reporting and logging it', async () => {
      const f = await createSlotFixture();
      const info = captureInfo();
      const now = new Date(f.disputedAt!.getTime() + 60_000);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { operator: '  Cafe\u0301  ', now }),
      );

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected an apply');
      expect(result.operator).toBe('Caf\u00e9');
      expect(info).toHaveBeenCalledWith('[slots] dispute resolved', {
        slotId: f.slotId,
        outcome: 'RESUME',
        operator: 'Caf\u00e9',
        resolvedAt: now.toISOString(),
      });
    });

    it('accepts an operator of exactly the maximum length', async () => {
      const f = await createSlotFixture();
      captureInfo();
      const maxOperator = '\u00e9'.repeat(MAX_OPERATOR_LENGTH);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { operator: maxOperator, apply: false }),
      );

      expect(result.kind).toBe('planned');
      if (result.kind !== 'planned') throw new Error('expected a plan');
      expect(result.operator).toBe(maxOperator);
    });

    it('allows a resolution exactly at the dispute timestamp (zero extension)', async () => {
      const f = await createSlotFixture();
      captureInfo();

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { now: f.disputedAt! }),
      );

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected an apply');
      expect(result.extensionMs).toBe(0);

      const stored = await readSlot(f.slotId);
      expect(stored.settlementEndsAt).toEqual(WINDOW_ENDS_AT);
      expect(stored.disputeResolvedAt).toEqual(f.disputedAt);
    });

    it('allows a resume when everything has already been paid', async () => {
      const f = await createSlotFixture({
        escrowAmount: '500.00',
        paidToDate: '500.00',
      });
      captureInfo();
      const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

      const result = await resolveDispute(prisma, input(f.slotId, { now }));

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected an apply');
      expect(result.unreleasedAmount).toBe('0.00');
      expect((await readSlot(f.slotId)).status).toBe(SlotStatus.IN_PROGRESS);
    });
  });

  // =========================================================================
  // 3. Apply CLOSE
  // =========================================================================

  describe('CLOSE', () => {
    it('closes the slot, stamps closedAt and leaves the settlement window alone', async () => {
      const f = await createSlotFixture({ paidToDate: '250.00' });
      const info = captureInfo();
      const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { outcome: 'CLOSE', now }),
      );

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected an apply');
      expect(result.newStatus).toBe('CLOSED');
      expect(result.newSettlementEndsAt).toBeNull();
      expect(result.extensionMs).toBeNull();
      expect(result.settlementEndsAt).toBe(WINDOW_ENDS_AT.toISOString());
      expect(result.unreleasedAmount).toBe('750.00');
      assertNoReasonLeak(result);

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.CLOSED);
      expect(stored.closedAt).toEqual(now);
      expect(stored.disputeResolvedAt).toEqual(now);
      expect(stored.settlementEndsAt).toEqual(WINDOW_ENDS_AT);
      expect(stored.escrowAmount.toFixed(2)).toBe('1000.00');
      expect(stored.paidToDate.toFixed(2)).toBe('250.00');
      expect(await payoutEventCount(f.slotId)).toBe(0);

      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith('[slots] dispute resolved', {
        slotId: f.slotId,
        outcome: 'CLOSE',
        operator: OPERATOR,
        resolvedAt: now.toISOString(),
      });
      assertNoReasonLeak(info.mock.calls);
    });

    it('closes a slot that has no settlement window', async () => {
      const f = await createSlotFixture({ settlementEndsAt: null });
      captureInfo();
      const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { outcome: 'CLOSE', now }),
      );

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected an apply');
      expect(result.newStatus).toBe('CLOSED');
      expect(result.settlementEndsAt).toBeNull();
      expect(result.newSettlementEndsAt).toBeNull();

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.CLOSED);
      expect(stored.settlementEndsAt).toBeNull();
    });

    it('refuses to close a slot with nothing left to pay', async () => {
      const f = await createSlotFixture({
        escrowAmount: '500.00',
        paidToDate: '500.00',
      });
      const info = captureInfo();
      const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { outcome: 'CLOSE', now }),
      );

      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('expected a refusal');
      expect(result.reason).toBe('nothing_to_close');

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.DISPUTED);
      expect(stored.closedAt).toBeNull();
      expect(stored.disputeResolvedAt).toBeNull();
      expect(info).not.toHaveBeenCalled();
      expect(await payoutEventCount(f.slotId)).toBe(0);
    });
  });

  // =========================================================================
  // 4. Refusals that must not write
  // =========================================================================

  describe('refusals', () => {
    it.each([
      SlotStatus.IN_PROGRESS,
      SlotStatus.COMPLETED,
      SlotStatus.CANCELLED,
      SlotStatus.CLOSED,
    ])('refuses not_disputed on a %s slot and writes nothing', async (status) => {
      const f = await createSlotFixture({ status });
      const info = captureInfo();

      const result = await resolveDispute(prisma, input(f.slotId));

      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('expected a refusal');
      expect(result.reason).toBe('not_disputed');

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(status);
      expect(stored.settlementEndsAt).toEqual(f.settlementEndsAt);
      expect(stored.disputeResolvedAt).toBeNull();
      expect(info).not.toHaveBeenCalled();
    });

    it('refuses slot_not_found for an unknown id', async () => {
      const info = captureInfo();

      const result = await resolveDispute(prisma, input('slot_does_not_exist'));

      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('expected a refusal');
      expect(result.reason).toBe('slot_not_found');
      expect(info).not.toHaveBeenCalled();
    });

    it('refuses slot_not_found for a soft-deleted slot', async () => {
      const f = await createSlotFixture({
        deletedAt: new Date('2026-02-02T00:00:00Z'),
      });
      const info = captureInfo();

      const result = await resolveDispute(prisma, input(f.slotId));

      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('expected a refusal');
      expect(result.reason).toBe('slot_not_found');

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.DISPUTED);
      expect(stored.disputeResolvedAt).toBeNull();
      expect(info).not.toHaveBeenCalled();
    });

    it('refuses clock_before_dispute and writes nothing', async () => {
      const f = await createSlotFixture();
      const info = captureInfo();
      const tooEarly = new Date(f.disputedAt!.getTime() - 1);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { now: tooEarly }),
      );

      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('expected a refusal');
      expect(result.reason).toBe('clock_before_dispute');

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.DISPUTED);
      expect(stored.disputeResolvedAt).toBeNull();
      expect(stored.settlementEndsAt).toEqual(WINDOW_ENDS_AT);
      expect(info).not.toHaveBeenCalled();
    });

    it('refuses missing_settlement_window on resume and writes nothing', async () => {
      const f = await createSlotFixture({ settlementEndsAt: null });
      const info = captureInfo();
      const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

      const result = await resolveDispute(prisma, input(f.slotId, { now }));

      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('expected a refusal');
      expect(result.reason).toBe('missing_settlement_window');

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.DISPUTED);
      expect(stored.settlementEndsAt).toBeNull();
      expect(stored.disputeResolvedAt).toBeNull();
      expect(info).not.toHaveBeenCalled();
    });

    it('applies when expectedDisputedAt matches the current dispute', async () => {
      const f = await createSlotFixture();
      captureInfo();
      const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, { now, expectedDisputedAt: f.disputedAt! }),
      );

      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('expected an apply');
      expect((await readSlot(f.slotId)).status).toBe(SlotStatus.IN_PROGRESS);
    });

    it('refuses dispute_changed when expectedDisputedAt is from an older dispute', async () => {
      const f = await createSlotFixture();
      const info = captureInfo();
      const stale = new Date(f.disputedAt!.getTime() - 60_000);
      const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

      const result = await resolveDispute(
        prisma,
        input(f.slotId, {
          outcome: 'CLOSE',
          now,
          expectedDisputedAt: stale,
        }),
      );

      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('expected a refusal');
      expect(result.reason).toBe('dispute_changed');

      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(SlotStatus.DISPUTED);
      expect(stored.closedAt).toBeNull();
      expect(info).not.toHaveBeenCalled();
    });

    const INVALID_INPUT_CASES: { label: string; patch: Record<string, unknown> }[] =
      [
        { label: 'a slot id with spaces', patch: { slotId: 'not a slot id' } },
        { label: 'an empty slot id', patch: { slotId: '' } },
        { label: 'a slot id with a slash', patch: { slotId: 'slot/abc' } },
        { label: 'an empty operator', patch: { operator: '' } },
        { label: 'a whitespace-only operator', patch: { operator: '   ' } },
        { label: 'an operator with a newline', patch: { operator: 'alice\nbob' } },
        { label: 'an operator with a tab', patch: { operator: 'alice\tbob' } },
        { label: 'an operator with a NUL', patch: { operator: 'alice\u0000bob' } },
        {
          label: 'an operator with a bidi override',
          patch: { operator: 'alice\u202Ebob' },
        },
        {
          label: 'an operator over the maximum length',
          patch: { operator: 'a'.repeat(MAX_OPERATOR_LENGTH + 1) },
        },
        { label: 'an unknown outcome', patch: { outcome: 'CANCEL' } },
      ];

    it.each(INVALID_INPUT_CASES)(
      'refuses invalid_input for $label without touching the slot',
      async ({ patch }) => {
        const f = await createSlotFixture();
        const info = captureInfo();

        const result = await resolveDispute(prisma, {
          ...input(f.slotId),
          ...patch,
        } as unknown as ResolveDisputeInput);

        expect(result.kind).toBe('refused');
        if (result.kind !== 'refused') throw new Error('expected a refusal');
        expect(result.reason).toBe('invalid_input');
        expect(result.message).not.toContain(REASON_CANARY);

        const stored = await readSlot(f.slotId);
        expect(stored.status).toBe(SlotStatus.DISPUTED);
        expect(stored.disputeResolvedAt).toBeNull();
        expect(info).not.toHaveBeenCalled();
      },
    );
  });

  // =========================================================================
  // 5. A re-raised dispute cannot be resolved by a stale plan
  // =========================================================================

  it('refuses a plan from an earlier dispute after the slot is re-disputed', async () => {
    const f = await createSlotFixture();
    captureInfo();
    const firstResolution = new Date(f.disputedAt!.getTime() + HOUR_MS);

    const first = await resolveDispute(
      prisma,
      input(f.slotId, { now: firstResolution }),
    );
    expect(first.kind).toBe('applied');

    const reRaisedAt = new Date(f.disputedAt!.getTime() + 2 * HOUR_MS);
    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: {
        status: SlotStatus.DISPUTED,
        disputedAt: reRaisedAt,
        disputeReason: 'Second dispute',
        disputeRaisedByUserId: f.raiserUserId,
        disputeResolvedAt: null,
      },
    });

    const stale = await resolveDispute(
      prisma,
      input(f.slotId, {
        outcome: 'CLOSE',
        now: new Date(reRaisedAt.getTime() + 60_000),
        expectedDisputedAt: f.disputedAt!,
      }),
    );
    expect(stale.kind).toBe('refused');
    if (stale.kind !== 'refused') throw new Error('expected a refusal');
    expect(stale.reason).toBe('dispute_changed');

    const stillDisputed = await readSlot(f.slotId);
    expect(stillDisputed.status).toBe(SlotStatus.DISPUTED);
    expect(stillDisputed.disputedAt).toEqual(reRaisedAt);
    expect(stillDisputed.disputeResolvedAt).toBeNull();

    const fresh = await resolveDispute(
      prisma,
      input(f.slotId, {
        now: new Date(reRaisedAt.getTime() + 30_000),
        expectedDisputedAt: reRaisedAt,
      }),
    );
    expect(fresh.kind).toBe('applied');
    if (fresh.kind !== 'applied') throw new Error('expected an apply');
    expect(fresh.extensionMs).toBe(30_000);

    const stored = await readSlot(f.slotId);
    expect(stored.status).toBe(SlotStatus.IN_PROGRESS);
    expect(stored.settlementEndsAt).toEqual(
      new Date(WINDOW_ENDS_AT.getTime() + HOUR_MS + 30_000),
    );
  });

  // =========================================================================
  // 6. Concurrency: the compare-and-swap lets exactly one resolution win
  // =========================================================================

  it('applies exactly one of five concurrent RESUME calls', async () => {
    const f = await createSlotFixture();
    const info = captureInfo();
    const now = new Date(f.disputedAt!.getTime() + HOUR_MS);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveDispute(prisma, input(f.slotId, { now }))),
    );

    const applied = results.filter((result) => result.kind === 'applied');
    const refused = results.filter((result) => result.kind === 'refused');
    expect(applied).toHaveLength(1);
    expect(refused).toHaveLength(4);
    for (const result of refused) {
      if (result.kind !== 'refused') throw new Error('expected a refusal');
      // A loser that read the slot before the winner committed fails the
      // compare-and-swap (slot_changed); one that read it afterwards sees a
      // slot that is no longer DISPUTED (not_disputed). Both are correct, and
      // neither writes.
      expect(['slot_changed', 'not_disputed']).toContain(result.reason);
    }

    const stored = await readSlot(f.slotId);
    expect(stored.status).toBe(SlotStatus.IN_PROGRESS);
    expect(stored.settlementEndsAt).toEqual(
      new Date(WINDOW_ENDS_AT.getTime() + HOUR_MS),
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(await payoutEventCount(f.slotId)).toBe(0);
  });

  it('produces exactly one winner in 10 rounds of RESUME against CLOSE', async () => {
    const info = captureInfo();

    for (let round = 0; round < 10; round += 1) {
      const f = await createSlotFixture();
      const now = new Date(f.disputedAt!.getTime() + (round + 1) * 60_000);

      const [resume, close] = await Promise.all([
        resolveDispute(prisma, input(f.slotId, { now })),
        resolveDispute(
          prisma,
          input(f.slotId, { outcome: 'CLOSE', now }),
        ),
      ]);

      const kinds = [resume.kind, close.kind].sort();
      expect(kinds).toEqual(['applied', 'refused']);

      const resumeWon = resume.kind === 'applied';
      const stored = await readSlot(f.slotId);
      expect(stored.status).toBe(
        resumeWon ? SlotStatus.IN_PROGRESS : SlotStatus.CLOSED,
      );
      expect(stored.disputeResolvedAt).toEqual(now);
      expect(stored.closedAt === null).toBe(resumeWon);
      expect(await payoutEventCount(f.slotId)).toBe(0);

      const loser = resumeWon ? close : resume;
      if (loser.kind !== 'refused') throw new Error('expected a refusal');
      // Same two legitimate refusals as the concurrent RESUME test.
      expect(['slot_changed', 'not_disputed']).toContain(loser.reason);
    }

    expect(info).toHaveBeenCalledTimes(10);
  });

  // =========================================================================
  // 7. Settlement after resolution
  // =========================================================================

  it('settles normally after a RESUME', async () => {
    const f = await createSlotFixture();
    captureInfo();

    const resume = await resolveDispute(
      prisma,
      input(f.slotId, { now: new Date(f.disputedAt!.getTime() + HOUR_MS) }),
    );
    expect(resume.kind).toBe('applied');

    const outcome = await settleSlot(f.slotId, prisma, makeFakeMetrics(20000));

    expect(outcome.status).toBe('ADVANCED');
    if (outcome.status !== 'ADVANCED') throw new Error('expected an advance');
    expect(outcome.newTiers).toEqual([MilestoneTier.BASELINE]);

    const events = await prisma.payoutEvent.findMany({
      where: { slotId: f.slotId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.tier).toBe(MilestoneTier.BASELINE);
  });

  it('never settles after a CLOSE and writes no PayoutEvent', async () => {
    const f = await createSlotFixture();
    captureInfo();

    const close = await resolveDispute(
      prisma,
      input(f.slotId, {
        outcome: 'CLOSE',
        now: new Date(f.disputedAt!.getTime() + HOUR_MS),
      }),
    );
    expect(close.kind).toBe('applied');

    const metrics = makeExplodingMetrics();
    const outcome = await settleSlot(f.slotId, prisma, metrics.provider);

    expect(outcome.status).toBe('SKIPPED_NOT_ELIGIBLE');
    if (outcome.status !== 'SKIPPED_NOT_ELIGIBLE') {
      throw new Error('expected a skip');
    }
    expect(outcome.reason).toBe('slot_not_in_progress');
    expect(metrics.wasCalled()).toBe(false);
    expect(await payoutEventCount(f.slotId)).toBe(0);
  });

  // =========================================================================
  // 8. The database still refuses DISPUTED -> CANCELLED
  // =========================================================================

  it('leaves DISPUTED -> CANCELLED rejected by the database', async () => {
    const f = await createSlotFixture();

    let text = '';
    try {
      await prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: {
          status: SlotStatus.CANCELLED,
          cancelledAt: new Date('2026-02-05T00:00:00Z'),
        },
      });
    } catch (error) {
      const err = error as {
        message?: unknown;
        meta?: unknown;
        code?: unknown;
      };
      text = [
        typeof err.message === 'string' ? err.message : String(error),
        JSON.stringify(err.meta ?? null),
        typeof err.code === 'string' ? err.code : '',
      ].join(' | ');
    }

    expect(text).toContain(
      'A slot can only be cancelled from INVITED or ACCEPTED with nothing paid',
    );

    const stored = await readSlot(f.slotId);
    expect(stored.status).toBe(SlotStatus.DISPUTED);
    expect(stored.cancelledAt).toBeNull();
  });
});
