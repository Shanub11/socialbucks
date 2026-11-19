// apps/web/src/lib/campaigns/slot-status-guards.test.ts
//
// Real-database integration tests for the closure/dispute constraints and the
// slot_status_transition_guard trigger added by migration
// 20261114100100_slot_closure_and_dispute (ADR-0004 D2, D3, D4).
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only the database is real: no provider is faked except the MetricsProvider
// passed to settleSlot, and that one asserts it is never called.
//
// Run: RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... vitest run slot-status-guards.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
import { createInvite } from '@/lib/invites/create-invite';
import { settleSlot, type MetricsProvider } from '@/lib/settlement/settle-slot';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 — slot-status-guards tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

// Distinctive fragments of the database messages, so a failure says which rule
// fired rather than only "a constraint failed".
const ERR_CLOSED_WITHOUT_CLOSED_AT = 'slot_closed_requires_closed_at';
const ERR_DISPUTE_RECORD = 'slot_disputed_requires_record';
const ERR_REASON_LEN = 'slot_dispute_reason_len';
const ERR_RESOLVED_ORDER = 'slot_dispute_resolved_order';
const ERR_DISPUTE_FK = 'CampaignCreatorSlot_disputeRaisedByUserId_fkey';
const ERR_DISPUTE_TRANSITION = 'A dispute can only be raised on an IN_PROGRESS slot';
const ERR_CLOSE_TRANSITION = 'A slot can only be closed from IN_PROGRESS or DISPUTED';
const ERR_CANCEL_TRANSITION =
  'A slot can only be cancelled from INVITED or ACCEPTED with nothing paid';

describeDb('slot closure, dispute and status transition guards (real DB)', () => {
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
        `[slot-status-guards] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
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

  // -------------------------------------------------------------------------
  // Fixture
  // -------------------------------------------------------------------------

  interface SlotOptions {
    status?: SlotStatus;
    escrowAmount?: string;
    paidToDate?: string;
    totalBudget?: string;
    approvedAt?: Date | null;
    closedAt?: Date | null;
  }

  interface SlotFixture {
    slotId: string;
    campaignId: string;
    organizationId: string;
    creatorId: string;
    creatorUserId: string;
    raiserUserId: string;
  }

  async function createSlotFixture(
    overrides: SlotOptions = {},
  ): Promise<SlotFixture> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const status = overrides.status ?? SlotStatus.IN_PROGRESS;

    const org = await prisma.organization.create({
      data: { name: `Status Org ${suffix}` },
      select: { id: true },
    });

    // The user that raises disputes (a real row, so the FK is satisfiable).
    const raiserUser = await prisma.user.create({
      data: {
        clerkId: `clerk_status_raiser_${suffix}`,
        email: `raiser_${suffix}@test.local`,
      },
      select: { id: true },
    });

    const creatorUser = await prisma.user.create({
      data: {
        clerkId: `clerk_status_creator_${suffix}`,
        email: `slot_creator_${suffix}@test.local`,
      },
      select: { id: true },
    });

    const creator = await prisma.creator.create({
      data: { userId: creatorUser.id },
      select: { id: true },
    });

    await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId: `ext_${suffix}`,
        handle: `handle_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake_${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Status Campaign ${suffix}`,
        totalBudget: new Prisma.Decimal(overrides.totalBudget ?? '1000.00'),
        currency: 'USD',
        status: CampaignStatus.ACTIVE,
        submissionDeadline: new Date(Date.now() + 30 * DAY_MS),
      },
      select: { id: true },
    });

    // Inserting in the target state requires that state's record columns:
    // slot_disputed_requires_record and slot_closed_requires_closed_at are
    // CHECK constraints, so they apply to INSERT as well as UPDATE.
    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        status,
        escrowAmount: new Prisma.Decimal(overrides.escrowAmount ?? '1000.00'),
        paidToDate: new Prisma.Decimal(overrides.paidToDate ?? '0.00'),
        viewTarget: 1000,
        metric: 'engagedViews',
        invitedAt: new Date(),
        approvedAt: overrides.approvedAt ?? null,
        ...(status === SlotStatus.DISPUTED
          ? {
              disputedAt: new Date('2026-02-01T00:00:00Z'),
              disputeReason: 'Fixture dispute',
              disputeRaisedByUserId: raiserUser.id,
            }
          : {}),
        ...(status === SlotStatus.CLOSED
          ? { closedAt: overrides.closedAt ?? new Date('2026-03-01T00:00:00Z') }
          : {}),
        ...(status === SlotStatus.CANCELLED
          ? { cancelledAt: new Date('2026-02-15T00:00:00Z') }
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
      raiserUserId: raiserUser.id,
    };
  }

  /** A second creator an invite can be addressed to: connected, not a member. */
  async function createEligibleCreator(): Promise<{ email: string }> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const user = await prisma.user.create({
      data: {
        clerkId: `clerk_status_eligible_${suffix}`,
        email: `eligible_${suffix}@test.local`,
      },
      select: { id: true, email: true },
    });
    const creator = await prisma.creator.create({
      data: { userId: user.id },
      select: { id: true },
    });
    await prisma.socialAccount.create({
      data: {
        creatorId: creator.id,
        platform: SocialPlatform.YOUTUBE,
        externalId: `ext_eligible_${suffix}`,
        handle: `eligible_${suffix}`,
        scopes: ['yt-analytics.readonly'],
        tokenCiphertext: `v1.fake_eligible_${suffix}`,
        revokedAt: null,
      },
      select: { id: true },
    });
    return { email: user.email };
  }

  /**
   * Runs a write that the database must refuse and returns everything the
   * thrown error says about it. Asserting on the joined text (message, meta and
   * code) keeps the test stable across Prisma's error mapping while still
   * pinning the specific rule that fired.
   */
  async function dbError(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      const err = error as { message?: unknown; meta?: unknown; code?: unknown };
      return [
        typeof err.message === 'string' ? err.message : String(error),
        JSON.stringify(err.meta ?? null),
        typeof err.code === 'string' ? err.code : '',
      ].join(' | ');
    }
    throw new Error('expected the database to reject this write, but it succeeded');
  }

  async function readSlot(slotId: string) {
    return prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotId } });
  }

  const NOW = new Date('2026-04-01T12:00:00Z');

  // =======================================================================
  // 1. CLOSED requires closedAt
  // =======================================================================

  it('allows IN_PROGRESS -> CLOSED when closedAt is set', async () => {
    const f = await createSlotFixture();

    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { status: SlotStatus.CLOSED, closedAt: NOW },
    });

    const after = await readSlot(f.slotId);
    expect(after.status).toBe(SlotStatus.CLOSED);
    expect(after.closedAt).toEqual(NOW);
  });

  it('rejects CLOSED without closedAt (slot_closed_requires_closed_at)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: { status: SlotStatus.CLOSED },
      }),
    );
    expect(text).toContain(ERR_CLOSED_WITHOUT_CLOSED_AT);

    const after = await readSlot(f.slotId);
    expect(after.status).toBe(SlotStatus.IN_PROGRESS);
    expect(after.closedAt).toBeNull();
  });

  // =======================================================================
  // 2. DISPUTED requires its full record
  // =======================================================================

  it('allows IN_PROGRESS -> DISPUTED with disputedAt, disputeReason and disputeRaisedByUserId', async () => {
    const f = await createSlotFixture();

    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: {
        status: SlotStatus.DISPUTED,
        disputedAt: NOW,
        disputeReason: 'Content was taken down',
        disputeRaisedByUserId: f.raiserUserId,
      },
    });

    const after = await readSlot(f.slotId);
    expect(after.status).toBe(SlotStatus.DISPUTED);
    expect(after.disputedAt).toEqual(NOW);
    expect(after.disputeReason).toBe('Content was taken down');
    expect(after.disputeRaisedByUserId).toBe(f.raiserUserId);
  });

  it('rejects DISPUTED without disputedAt (slot_disputed_requires_record)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: {
          status: SlotStatus.DISPUTED,
          disputeReason: 'Missing the timestamp',
          disputeRaisedByUserId: f.raiserUserId,
        },
      }),
    );
    expect(text).toContain(ERR_DISPUTE_RECORD);
    expect((await readSlot(f.slotId)).status).toBe(SlotStatus.IN_PROGRESS);
  });

  it('rejects DISPUTED without disputeReason (slot_disputed_requires_record)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: {
          status: SlotStatus.DISPUTED,
          disputedAt: NOW,
          disputeRaisedByUserId: f.raiserUserId,
        },
      }),
    );
    expect(text).toContain(ERR_DISPUTE_RECORD);
    expect((await readSlot(f.slotId)).status).toBe(SlotStatus.IN_PROGRESS);
  });

  it('rejects DISPUTED without disputeRaisedByUserId (slot_disputed_requires_record)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: {
          status: SlotStatus.DISPUTED,
          disputedAt: NOW,
          disputeReason: 'Missing the raiser',
        },
      }),
    );
    expect(text).toContain(ERR_DISPUTE_RECORD);
    expect((await readSlot(f.slotId)).status).toBe(SlotStatus.IN_PROGRESS);
  });

  it('rejects an unknown disputeRaisedByUserId (foreign key)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: {
          status: SlotStatus.DISPUTED,
          disputedAt: NOW,
          disputeReason: 'Unknown raiser',
          disputeRaisedByUserId: 'user_does_not_exist',
        },
      }),
    );
    expect(text).toContain(ERR_DISPUTE_FK);
    expect((await readSlot(f.slotId)).status).toBe(SlotStatus.IN_PROGRESS);
  });

  // =======================================================================
  // 3. disputeReason length
  // =======================================================================

  it('rejects a 0-character disputeReason (slot_dispute_reason_len)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: { disputeReason: '' },
      }),
    );
    expect(text).toContain(ERR_REASON_LEN);
  });

  it('rejects a 1001-character disputeReason (slot_dispute_reason_len)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: { disputeReason: 'x'.repeat(1001) },
      }),
    );
    expect(text).toContain(ERR_REASON_LEN);
  });

  it('accepts a 1-character disputeReason', async () => {
    const f = await createSlotFixture();

    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { disputeReason: 'x' },
    });
    expect((await readSlot(f.slotId)).disputeReason).toHaveLength(1);
  });

  it('accepts a 1000-character disputeReason', async () => {
    const f = await createSlotFixture();

    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { disputeReason: 'x'.repeat(1000) },
    });
    expect((await readSlot(f.slotId)).disputeReason).toHaveLength(1000);
  });

  // =======================================================================
  // 4. Resolution ordering
  // =======================================================================

  it('rejects disputeResolvedAt before disputedAt (slot_dispute_resolved_order)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: {
          disputedAt: NOW,
          disputeResolvedAt: new Date(NOW.getTime() - 1000),
        },
      }),
    );
    expect(text).toContain(ERR_RESOLVED_ORDER);
  });

  it('accepts disputeResolvedAt equal to disputedAt', async () => {
    const f = await createSlotFixture();

    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { disputedAt: NOW, disputeResolvedAt: NOW },
    });
    const after = await readSlot(f.slotId);
    expect(after.disputeResolvedAt).toEqual(NOW);
  });

  it('rejects disputeResolvedAt without disputedAt (slot_dispute_resolved_order)', async () => {
    const f = await createSlotFixture();

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: { disputeResolvedAt: NOW },
      }),
    );
    expect(text).toContain(ERR_RESOLVED_ORDER);
    expect((await readSlot(f.slotId)).disputeResolvedAt).toBeNull();
  });

  // =======================================================================
  // 5. Transition guard: -> DISPUTED
  // =======================================================================

  const NON_DISPUTABLE_STATUSES: SlotStatus[] = [
    SlotStatus.INVITED,
    SlotStatus.ACCEPTED,
    SlotStatus.CONTENT_SUBMITTED,
    SlotStatus.COMPLETED,
  ];

  it.each(NON_DISPUTABLE_STATUSES)(
    'rejects %s -> DISPUTED with a restrict_violation',
    async (status) => {
      const f = await createSlotFixture({ status });

      const text = await dbError(() =>
        prisma.campaignCreatorSlot.update({
          where: { id: f.slotId },
          data: {
            status: SlotStatus.DISPUTED,
            disputedAt: NOW,
            disputeReason: 'Cannot be raised here',
            disputeRaisedByUserId: f.raiserUserId,
          },
        }),
      );
      expect(text).toContain(ERR_DISPUTE_TRANSITION);

      const after = await readSlot(f.slotId);
      expect(after.status).toBe(status);
      expect(after.disputedAt).toBeNull();
    },
  );

  // =======================================================================
  // 6. Transition guard: -> CLOSED
  // =======================================================================

  const NON_CLOSABLE_STATUSES: SlotStatus[] = [
    SlotStatus.INVITED,
    SlotStatus.ACCEPTED,
    SlotStatus.CONTENT_SUBMITTED,
    SlotStatus.COMPLETED,
    SlotStatus.CANCELLED,
  ];

  it.each(NON_CLOSABLE_STATUSES)(
    'rejects %s -> CLOSED with a restrict_violation',
    async (status) => {
      const f = await createSlotFixture({ status });

      const text = await dbError(() =>
        prisma.campaignCreatorSlot.update({
          where: { id: f.slotId },
          data: { status: SlotStatus.CLOSED, closedAt: NOW },
        }),
      );
      expect(text).toContain(ERR_CLOSE_TRANSITION);

      const after = await readSlot(f.slotId);
      expect(after.status).toBe(status);
      expect(after.closedAt).toBeNull();
    },
  );

  it('allows DISPUTED -> CLOSED with closedAt', async () => {
    const f = await createSlotFixture({ status: SlotStatus.DISPUTED });

    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { status: SlotStatus.CLOSED, closedAt: NOW },
    });

    const after = await readSlot(f.slotId);
    expect(after.status).toBe(SlotStatus.CLOSED);
    expect(after.closedAt).toEqual(NOW);
  });

  // =======================================================================
  // 7. Transition guard: -> CANCELLED
  // =======================================================================

  const NON_CANCELLABLE_SOURCES: SlotStatus[] = [
    SlotStatus.CONTENT_SUBMITTED,
    SlotStatus.IN_PROGRESS,
    SlotStatus.DISPUTED,
    SlotStatus.COMPLETED,
    SlotStatus.CLOSED,
  ];

  it.each(NON_CANCELLABLE_SOURCES)(
    'rejects %s -> CANCELLED with a restrict_violation',
    async (status) => {
      const f = await createSlotFixture({ status });

      const text = await dbError(() =>
        prisma.campaignCreatorSlot.update({
          where: { id: f.slotId },
          data: { status: SlotStatus.CANCELLED, cancelledAt: NOW },
        }),
      );
      expect(text).toContain(ERR_CANCEL_TRANSITION);

      const after = await readSlot(f.slotId);
      expect(after.status).toBe(status);
    },
  );

  it.each([SlotStatus.INVITED, SlotStatus.ACCEPTED])(
    'allows %s -> CANCELLED with nothing paid',
    async (status) => {
      const f = await createSlotFixture({ status });

      await prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: { status: SlotStatus.CANCELLED, cancelledAt: NOW },
      });

      const after = await readSlot(f.slotId);
      expect(after.status).toBe(SlotStatus.CANCELLED);
      expect(after.cancelledAt).toEqual(NOW);
    },
  );

  it('rejects ACCEPTED -> CANCELLED when approvedAt is already set', async () => {
    const f = await createSlotFixture({
      status: SlotStatus.ACCEPTED,
      approvedAt: new Date('2026-01-05T00:00:00Z'),
    });

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: { status: SlotStatus.CANCELLED, cancelledAt: NOW },
      }),
    );
    expect(text).toContain(ERR_CANCEL_TRANSITION);

    const after = await readSlot(f.slotId);
    expect(after.status).toBe(SlotStatus.ACCEPTED);
    expect(after.cancelledAt).toBeNull();
  });

  it('rejects ACCEPTED -> CANCELLED when paidToDate > 0', async () => {
    const f = await createSlotFixture({
      status: SlotStatus.ACCEPTED,
      paidToDate: '100.00',
    });

    const text = await dbError(() =>
      prisma.campaignCreatorSlot.update({
        where: { id: f.slotId },
        data: { status: SlotStatus.CANCELLED, cancelledAt: NOW },
      }),
    );
    expect(text).toContain(ERR_CANCEL_TRANSITION);

    const after = await readSlot(f.slotId);
    expect(after.status).toBe(SlotStatus.ACCEPTED);
    expect(after.paidToDate.toFixed(2)).toBe('100.00');
  });

  // =======================================================================
  // 8. Same-status writes are not transitions
  // =======================================================================

  it('does not block a view-count cache write on an IN_PROGRESS slot', async () => {
    const f = await createSlotFixture({ status: SlotStatus.IN_PROGRESS });

    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: {
        currentViewCount: 1234,
        lastViewCheckAt: NOW,
        currentTier: MilestoneTier.TIER_40,
        paidToDate: new Prisma.Decimal('400.00'),
      },
    });

    const after = await readSlot(f.slotId);
    expect(after.status).toBe(SlotStatus.IN_PROGRESS);
    expect(after.currentViewCount).toBe(1234);
    expect(after.currentTier).toBe(MilestoneTier.TIER_40);
    expect(after.paidToDate.toFixed(2)).toBe('400.00');
  });

  it('does not block an explicit write of the same status', async () => {
    const f = await createSlotFixture({ status: SlotStatus.IN_PROGRESS });

    await prisma.campaignCreatorSlot.update({
      where: { id: f.slotId },
      data: { status: SlotStatus.IN_PROGRESS },
    });

    expect((await readSlot(f.slotId)).status).toBe(SlotStatus.IN_PROGRESS);
  });

  // =======================================================================
  // 9. A CLOSED slot still commits its escrow; a CANCELLED one does not
  // =======================================================================

  it('counts a CLOSED slot against the budget but frees a CANCELLED one', async () => {
    const closed = await createSlotFixture({
      status: SlotStatus.CLOSED,
      escrowAmount: '1000.00',
      totalBudget: '1000.00',
    });
    const cancelled = await createSlotFixture({
      status: SlotStatus.CANCELLED,
      escrowAmount: '1000.00',
      totalBudget: '1000.00',
    });

    const firstCreator = await createEligibleCreator();
    const closedInvite = await createInvite({
      organizationId: closed.organizationId,
      campaignId: closed.campaignId,
      creatorEmail: firstCreator.email,
      escrowAmount: new Prisma.Decimal('100.00'),
      viewTarget: 1000,
    });
    expect(closedInvite.kind).toBe('budget_exceeded');

    // CLOSED is not a freed status, so its whole escrow still counts.
    const secondCreator = await createEligibleCreator();
    const cancelledInvite = await createInvite({
      organizationId: cancelled.organizationId,
      campaignId: cancelled.campaignId,
      creatorEmail: secondCreator.email,
      escrowAmount: new Prisma.Decimal('100.00'),
      viewTarget: 1000,
    });
    expect(cancelledInvite.kind).toBe('created');
  });

  // =======================================================================
  // 10. The settlement engine skips both states and writes nothing
  // =======================================================================

  function makeExplodingMetrics(): { provider: MetricsProvider; wasCalled: () => boolean } {
    let called = false;
    return {
      provider: {
        async fetchMetrics() {
          called = true;
          throw new Error('metrics provider must not be called for an ineligible slot');
        },
      },
      wasCalled: () => called,
    };
  }

  it.each([SlotStatus.DISPUTED, SlotStatus.CLOSED])(
    'settleSlot skips a %s slot without writing a PayoutEvent',
    async (status) => {
      const f = await createSlotFixture({ status });
      const metrics = makeExplodingMetrics();

      const outcome = await settleSlot(f.slotId, prisma, metrics.provider);

      expect(outcome.status).toBe('SKIPPED_NOT_ELIGIBLE');
      if (outcome.status !== 'SKIPPED_NOT_ELIGIBLE') throw new Error('unreachable');
      expect(outcome.reason).toBe('slot_not_in_progress');
      expect(metrics.wasCalled()).toBe(false);

      const events = await prisma.payoutEvent.count({ where: { slotId: f.slotId } });
      expect(events).toBe(0);
    },
  );
});
