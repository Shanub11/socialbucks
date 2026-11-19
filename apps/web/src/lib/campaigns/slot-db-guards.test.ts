// apps/web/src/lib/campaigns/slot-db-guards.test.ts
//
// Real-database integration tests for the database-level guards on
// CampaignCreatorSlot payout terms immutability and the PayoutEvent append-only
// ledger (added by migration 20261029100000_slot_lifecycle_and_db_guards).
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY — it never silently skips.
//
// Only the database is real — no external providers are faked.
//
// Run: RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... vitest run slot-db-guards.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient, SlotStatus, MilestoneTier, Prisma } from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';
const Decimal = Prisma.Decimal;

const MOCK_CLERK_USER_ID = 'clerk_test_slot_guards';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn().mockResolvedValue({ userId: MOCK_CLERK_USER_ID, sessionClaims: null }),
}));

import { resetTestDatabase } from '@/test/reset-test-db';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn('RUN_DB_TESTS != 1 — slot-db-guards tests are SKIPPED, not passing.');
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDb('slot database guards (real DB)', () => {
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
        `[slot-db-guards] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
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
  // Fixture: create an INVITED slot with known terms
  // ---------------------------------------------------------------------------

  async function createInvitedSlot(
    overrides: {
      escrowAmount?: string;
      viewTarget?: number | null;
      metric?: string | null;
      status?: SlotStatus;
    } = {},
  ) {
    const suffix = Math.random().toString(36).slice(2, 10);

    const user = await prisma.user.create({
      data: { clerkId: `clerk_${suffix}`, email: `user_${suffix}@test.local` },
      select: { id: true },
    });

    const creator = await prisma.creator.create({ data: { userId: user.id }, select: { id: true } });

    const org = await prisma.organization.create({ data: { name: `Org ${suffix}` }, select: { id: true } });

    const campaign = await prisma.campaign.create({
      data: {
        organizationId: org.id,
        title: `Campaign ${suffix}`,
        totalBudget: new Decimal('10000.00'),
        currency: 'USD',
      },
      select: { id: true },
    });

    const slot = await prisma.campaignCreatorSlot.create({
      data: {
        campaignId: campaign.id,
        creatorId: creator.id,
        status: overrides.status ?? SlotStatus.INVITED,
        escrowAmount: new Decimal(overrides.escrowAmount ?? '1000.00'),
        viewTarget: overrides.viewTarget ?? 100000,
        metric: overrides.metric ?? 'engagedViews',
        invitedAt: new Date(),
      },
      select: { id: true, status: true, escrowAmount: true, viewTarget: true, metric: true },
    });

    return { slot, campaignId: campaign.id, orgId: org.id };
  }

  // ---------------------------------------------------------------------------
  // Helper: assert that an update rejects AND the row is unchanged
  // ---------------------------------------------------------------------------

  async function assertRejectedAndUnchanged(
    slotId: string,
    before: { status: SlotStatus; escrowAmount: Prisma.Decimal; viewTarget: number | null; metric: string | null },
    updateFn: () => Promise<unknown>,
  ): Promise<void> {
    await expect(updateFn()).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotId } });
    expect(after.status).toBe(before.status);
    expect(after.escrowAmount).toEqual(before.escrowAmount);
    expect(after.viewTarget).toBe(before.viewTarget);
    expect(after.metric).toBe(before.metric);
  }

  // ---------------------------------------------------------------------------
  // INVITED slot: terms can still be updated
  // ---------------------------------------------------------------------------

  describe('INVITED slot — terms mutable', () => {
    it('escrowAmount can be updated', async () => {
      const { slot } = await createInvitedSlot();
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slot.id },
        select: { escrowAmount: true, status: true },
      });

      await prisma.campaignCreatorSlot.update({
        where: { id: slot.id },
        data: { escrowAmount: new Decimal('2000.00') },
      });

      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({
        where: { id: slot.id },
        select: { escrowAmount: true, status: true },
      });
      expect(after.escrowAmount.toFixed(2)).toBe('2000.00');
      expect(after.status).toBe(SlotStatus.INVITED);
      // Status unchanged
      expect(after.status).toBe(before.status);
    });

    it('viewTarget can be updated', async () => {
      const { slot } = await createInvitedSlot();
      await prisma.campaignCreatorSlot.update({
        where: { id: slot.id },
        data: { viewTarget: 200000 },
      });
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after.viewTarget).toBe(200000);
    });

    it('metric can be updated', async () => {
      const { slot } = await createInvitedSlot();
      await prisma.campaignCreatorSlot.update({
        where: { id: slot.id },
        data: { metric: 'views' },
      });
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after.metric).toBe('views');
    });
  });

  // ---------------------------------------------------------------------------
  // ACCEPTED slot: terms immutable, status and unrelated timestamps still work
  // ---------------------------------------------------------------------------

  describe('ACCEPTED slot — terms immutable', () => {
    it('updating escrowAmount is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.ACCEPTED });
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });

      await assertRejectedAndUnchanged(slot.id, before, () =>
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { escrowAmount: new Decimal('2000.00') },
        }),
      );
    });

    it('updating viewTarget is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.ACCEPTED });
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });

      await assertRejectedAndUnchanged(slot.id, before, () =>
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { viewTarget: 200000 },
        }),
      );
    });

    it('updating metric is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.ACCEPTED });
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });

      await assertRejectedAndUnchanged(slot.id, before, () =>
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { metric: 'views' },
        }),
      );
    });

    it('updating status still works', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.ACCEPTED });
      await prisma.campaignCreatorSlot.update({
        where: { id: slot.id },
        data: { status: SlotStatus.CONTENT_SUBMITTED },
      });
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after.status).toBe(SlotStatus.CONTENT_SUBMITTED);
    });

    it('updating unrelated timestamps still works', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.ACCEPTED });
      const now = new Date();
      await prisma.campaignCreatorSlot.update({
        where: { id: slot.id },
        data: { reviewDueAt: now },
      });
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after.reviewDueAt).toEqual(now);
    });
  });

  // ---------------------------------------------------------------------------
  // CHECK constraints
  // ---------------------------------------------------------------------------

  describe('CHECK constraints', () => {
    it('escrowAmount = 0 is rejected', async () => {
      const { slot } = await createInvitedSlot();
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      await expect(
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { escrowAmount: new Decimal('0.00') },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after).toEqual(before);
    });

    it('paidToDate > escrowAmount is rejected', async () => {
      const { slot } = await createInvitedSlot();
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      await expect(
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { paidToDate: new Decimal('2000.00'), escrowAmount: new Decimal('1000.00') },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after).toEqual(before);
    });

    it('viewTarget = 0 is rejected', async () => {
      const { slot } = await createInvitedSlot();
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      await expect(
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { viewTarget: 0 },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after).toEqual(before);
    });

    it('metric = bogus is rejected', async () => {
      const { slot } = await createInvitedSlot();
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      await expect(
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { metric: 'bogus' },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after).toEqual(before);
    });

    it('empty rejectionReason is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.ACCEPTED });
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      await expect(
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { rejectionReason: '' },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after).toEqual(before);
    });

    it('1001-character rejectionReason is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.ACCEPTED });
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      await expect(
        prisma.campaignCreatorSlot.update({
          where: { id: slot.id },
          data: { rejectionReason: 'x'.repeat(1001) },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after).toEqual(before);
    });

    it('1000-character rejectionReason is accepted', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.ACCEPTED });
      const before = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      await prisma.campaignCreatorSlot.update({
        where: { id: slot.id },
        data: { rejectionReason: 'x'.repeat(1000) },
      });
      const after = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slot.id } });
      expect(after.rejectionReason).toHaveLength(1000);
      // Other fields unchanged
      expect(after.escrowAmount).toEqual(before.escrowAmount);
      expect(after.viewTarget).toBe(before.viewTarget);
      expect(after.metric).toBe(before.metric);
      expect(after.status).toBe(before.status);
    });
  });

  // ---------------------------------------------------------------------------
  // PayoutEvent guards
  // ---------------------------------------------------------------------------

  describe('PayoutEvent append-only ledger', () => {
    async function createSlotWithPayoutEvent(
      tier: MilestoneTier = MilestoneTier.BASELINE,
      billableViews: number | null = 20000,
      billableMetric: string | null = 'engagedViews',
      thresholdViews: number | null = 20000,
    ) {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const event = await prisma.payoutEvent.create({
        data: {
          slotId: slot.id,
          tier,
          amount: new Decimal('200.00'),
          currency: 'USD',
          billableViews,
          billableMetric,
          thresholdViews,
          settlementJson: { test: true },
        },
        select: { id: true, tier: true, amount: true },
      });
      return { slot, event };
    }

    it('BASELINE row with all three billable fields null is accepted', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const event = await prisma.payoutEvent.create({
        data: {
          slotId: slot.id,
          tier: MilestoneTier.BASELINE,
          amount: new Decimal('200.00'),
          currency: 'USD',
          billableViews: null,
          billableMetric: null,
          thresholdViews: null,
          settlementJson: { test: true },
        },
        select: { id: true, tier: true, billableViews: true },
      });
      expect(event.tier).toBe(MilestoneTier.BASELINE);
      expect(event.billableViews).toBeNull();
    });

    it('TIER_40 row with all three billable fields set is accepted', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const event = await prisma.payoutEvent.create({
        data: {
          slotId: slot.id,
          tier: MilestoneTier.TIER_40,
          amount: new Decimal('200.00'),
          currency: 'USD',
          billableViews: 40000,
          billableMetric: 'engagedViews',
          thresholdViews: 40000,
          settlementJson: { test: true },
        },
        select: {
          id: true,
          tier: true,
          billableViews: true,
          billableMetric: true,
          thresholdViews: true,
        },
      });
      expect(event.tier).toBe(MilestoneTier.TIER_40);
      expect(event.billableViews).toBe(40000);
      expect(event.billableMetric).toBe('engagedViews');
      expect(event.thresholdViews).toBe(40000);
    });

    it('BASELINE row with a partial set of billable fields is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const countBefore = await prisma.payoutEvent.count({ where: { slotId: slot.id } });
      await expect(
        prisma.payoutEvent.create({
          data: {
            slotId: slot.id,
            tier: MilestoneTier.BASELINE,
            amount: new Decimal('200.00'),
            currency: 'USD',
            billableViews: 20000,
            billableMetric: null,
            thresholdViews: null,
            settlementJson: { test: true },
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const countAfter = await prisma.payoutEvent.count({ where: { slotId: slot.id } });
      expect(countAfter).toBe(countBefore);
    });

    it('TIER_40 row with all three billable fields null is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const countBefore = await prisma.payoutEvent.count({ where: { slotId: slot.id } });
      await expect(
        prisma.payoutEvent.create({
          data: {
            slotId: slot.id,
            tier: MilestoneTier.TIER_40,
            amount: new Decimal('200.00'),
            currency: 'USD',
            billableViews: null,
            billableMetric: null,
            thresholdViews: null,
            settlementJson: { test: true },
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const countAfter = await prisma.payoutEvent.count({ where: { slotId: slot.id } });
      expect(countAfter).toBe(countBefore);
    });

    it('TIER_40 row with a partial set of billable fields is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const countBefore = await prisma.payoutEvent.count({ where: { slotId: slot.id } });
      await expect(
        prisma.payoutEvent.create({
          data: {
            slotId: slot.id,
            tier: MilestoneTier.TIER_40,
            amount: new Decimal('200.00'),
            currency: 'USD',
            billableViews: 40000,
            billableMetric: null,
            thresholdViews: null,
            settlementJson: { test: true },
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const countAfter = await prisma.payoutEvent.count({ where: { slotId: slot.id } });
      expect(countAfter).toBe(countBefore);
    });

    it('DELETE on PayoutEvent is rejected', async () => {
      const { event } = await createSlotWithPayoutEvent();
      const before = await prisma.payoutEvent.findUniqueOrThrow({ where: { id: event.id } });
      await expect(prisma.payoutEvent.delete({ where: { id: event.id } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      // Row still exists and every guarded column is unchanged
      const after = await prisma.payoutEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.id).toBe(before.id);
      expect(after.amount.toFixed(2)).toBe(before.amount.toFixed(2));
      expect(after.tier).toBe(before.tier);
      expect(after.billableViews).toBe(before.billableViews);
      expect(after.billableMetric).toBe(before.billableMetric);
      expect(after.thresholdViews).toBe(before.thresholdViews);
    });

    it('UPDATE of amount is rejected', async () => {
      const { event } = await createSlotWithPayoutEvent();
      const before = await prisma.payoutEvent.findUniqueOrThrow({ where: { id: event.id } });
      await expect(
        prisma.payoutEvent.update({
          where: { id: event.id },
          data: { amount: new Decimal('999.00') },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      // Row unchanged
      const after = await prisma.payoutEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.id).toBe(before.id);
      expect(after.amount.toFixed(2)).toBe(before.amount.toFixed(2));
      expect(after.tier).toBe(before.tier);
      expect(after.billableViews).toBe(before.billableViews);
      expect(after.billableMetric).toBe(before.billableMetric);
      expect(after.thresholdViews).toBe(before.thresholdViews);
    });

    it('UPDATE of disbursementStatus is accepted', async () => {
      const { event } = await createSlotWithPayoutEvent();
      await prisma.payoutEvent.update({
        where: { id: event.id },
        data: { disbursementStatus: 'SENT' },
      });
      const after = await prisma.payoutEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.disbursementStatus).toBe('SENT');
    });

    it('UPDATE of disbursedAt is accepted', async () => {
      const { event } = await createSlotWithPayoutEvent();
      const now = new Date();
      await prisma.payoutEvent.update({
        where: { id: event.id },
        data: { disbursedAt: now },
      });
      const after = await prisma.payoutEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.disbursedAt).toEqual(now);
    });

    it('UPDATE of externalRef is accepted', async () => {
      const { event } = await createSlotWithPayoutEvent();
      await prisma.payoutEvent.update({
        where: { id: event.id },
        data: { externalRef: 'ext_ref_123' },
      });
      const after = await prisma.payoutEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(after.externalRef).toBe('ext_ref_123');
    });

    it('amount of 0 is accepted', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const event = await prisma.payoutEvent.create({
        data: {
          slotId: slot.id,
          tier: MilestoneTier.BASELINE,
          amount: new Decimal('0.00'),
          currency: 'USD',
          billableViews: null,
          billableMetric: null,
          thresholdViews: null,
          settlementJson: { test: true },
        },
        select: { id: true, amount: true },
      });
      expect(event.amount.toFixed(2)).toBe('0.00');
    });

    it('negative amount is rejected', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const countBefore = await prisma.payoutEvent.count({ where: { slotId: slot.id } });
      await expect(
        prisma.payoutEvent.create({
          data: {
            slotId: slot.id,
            tier: MilestoneTier.BASELINE,
            amount: new Decimal('-1.00'),
            currency: 'USD',
            billableViews: null,
            billableMetric: null,
            thresholdViews: null,
            settlementJson: { test: true },
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const countAfter = await prisma.payoutEvent.count({ where: { slotId: slot.id } });
      expect(countAfter).toBe(countBefore);
    });

    it('duplicate (slotId, tier) is rejected by unique constraint', async () => {
      const { slot } = await createInvitedSlot({ status: SlotStatus.IN_PROGRESS });
      const original = await prisma.payoutEvent.create({
        data: {
          slotId: slot.id,
          tier: MilestoneTier.BASELINE,
          amount: new Decimal('200.00'),
          currency: 'USD',
          billableViews: null,
          billableMetric: null,
          thresholdViews: null,
          settlementJson: { test: true },
        },
        select: { id: true, amount: true },
      });
      await expect(
        prisma.payoutEvent.create({
          data: {
            slotId: slot.id,
            tier: MilestoneTier.BASELINE,
            amount: new Decimal('300.00'),
            currency: 'USD',
            billableViews: null,
            billableMetric: null,
            thresholdViews: null,
            settlementJson: { test: true },
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      // Exactly one row for (slotId, tier), and it is still the original row
      const rowCount = await prisma.payoutEvent.count({
        where: { slotId: slot.id, tier: MilestoneTier.BASELINE },
      });
      expect(rowCount).toBe(1);
      const only = await prisma.payoutEvent.findUniqueOrThrow({
        where: { slotId_tier: { slotId: slot.id, tier: MilestoneTier.BASELINE } },
        select: { id: true, amount: true },
      });
      expect(only.id).toBe(original.id);
      expect(only.amount.toFixed(2)).toBe(original.amount.toFixed(2));
    });
  });
});
