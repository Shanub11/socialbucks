// apps/worker/src/jobs/expire-invites.test.ts
//
// Real database tests for the invite expiry job (ADR-0004, ADR-0006 D1).
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the database is unreachable, the
// suite FAILS LOUDLY - it never silently skips.
//
// Every fixture is created and deleted by this file; nothing here truncates a
// table, so a parallel or earlier run cannot lose data to this suite.

import type { PrismaClient } from '@repo/database';
import { prisma, SlotStatus } from '@repo/database';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCampaignWithInvites,
  removeFixture,
  type CampaignFixture,
} from '../test-support/fixtures';
import { createRecordingLogger } from '../test-support/recording-logger';
import type { JobContext } from './context';
import {
  expireInvites,
  INVITE_EXPIRY_BATCH_SIZE,
  INVITE_EXPIRY_MAX_BATCHES,
} from './expire-invites';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

if (!RUN_DB_TESTS) {
  console.warn(
    '[jobs/expire-invites.test] RUN_DB_TESTS != 1 - the invite expiry tests are SKIPPED, not passing.',
  );
}

if (RUN_DB_TESTS && !process.env.TEST_DATABASE_URL) {
  throw new Error('[jobs/expire-invites.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.');
}

// The vitest config points DATABASE_URL at TEST_DATABASE_URL. Refuse to run if
// something overrode that: these tests write rows.
if (RUN_DB_TESTS && process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
  throw new Error(
    '[jobs/expire-invites.test] DATABASE_URL and TEST_DATABASE_URL must be the same database.',
  );
}

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

/** The decision instant for every test that does not need a moving clock. */
const NOW = new Date('2026-11-16T12:00:00.000Z');

const SECOND = 1_000;

function context(db: PrismaClient = prisma, now: Date = NOW): {
  ctx: JobContext;
  recorder: ReturnType<typeof createRecordingLogger>;
} {
  const recorder = createRecordingLogger();
  return { ctx: { db, logger: recorder.logger, now: () => now }, recorder };
}

function laterInSeconds(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * SECOND);
}

// ---------------------------------------------------------------------------
// Row comparison, for the "nothing else changed" assertion
// ---------------------------------------------------------------------------

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    // Decimal and bigint carry toJSON; two rows of the same shape compare equal.
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

const EXPECTED_CHANGES = new Set(['status', 'updatedAt']);

function changedColumns(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !EXPECTED_CHANGES.has(key) && !sameValue(before[key], after[key]));
}

// ---------------------------------------------------------------------------
// A database client that loses the race on purpose
// ---------------------------------------------------------------------------

/**
 * Forwards every call to `prisma`, except that the first
 * campaignCreatorSlot.updateMany() is preceded by `beforeUpdate()` - which is how
 * a creator accepting an invite at the wrong microsecond is reproduced
 * deterministically instead of by timing.
 */
function dbWithRaceBeforeUpdate(
  beforeUpdate: () => Promise<void>,
): PrismaClient {
  let raced = false;

  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== 'campaignCreatorSlot') {
        return Reflect.get(target, property, receiver) as unknown;
      }

      const delegate = Reflect.get(target, property, receiver) as object;

      return new Proxy(delegate, {
        get(delegateTarget, delegateProperty, delegateReceiver) {
          if (delegateProperty !== 'updateMany') {
            return Reflect.get(delegateTarget, delegateProperty, delegateReceiver) as unknown;
          }

          return async (args: unknown) => {
            if (!raced) {
              raced = true;
              await beforeUpdate();
            }
            const original = Reflect.get(delegateTarget, delegateProperty) as (
              input: unknown,
            ) => Promise<{ count: number }>;
            return original.call(delegateTarget, args);
          };
        },
      });
    },
  }) as PrismaClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeDb('expireInvites (real DB)', () => {
  const created: CampaignFixture[] = [];

  async function fixture(
    options?: Parameters<typeof createCampaignWithInvites>[0],
  ): Promise<CampaignFixture> {
    const made = await createCampaignWithInvites(options);
    created.push(made);
    return made;
  }

  async function statusOf(slotId: string): Promise<SlotStatus> {
    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: { status: true },
    });
    return slot.status;
  }

  afterEach(async () => {
    while (created.length > 0) {
      const made = created.pop();
      if (made !== undefined) await removeFixture(made);
    }
    await prisma.$disconnect();
  });

  it('expires an INVITED slot whose invite window has passed', async () => {
    const { slotIds } = await fixture({ inviteExpiresAt: laterInSeconds(-1) });
    const { ctx } = context();

    const summary = await expireInvites(ctx);

    expect(summary).toEqual({ scanned: 1, expired: 1, truncated: false });
    expect(await statusOf(slotIds[0]!)).toBe(SlotStatus.EXPIRED);
  });

  it('leaves an invite that has not expired yet alone', async () => {
    const { slotIds } = await fixture({ inviteExpiresAt: laterInSeconds(1) });
    const { ctx } = context();

    const summary = await expireInvites(ctx);

    expect(summary).toEqual({ scanned: 0, expired: 0, truncated: false });
    expect(await statusOf(slotIds[0]!)).toBe(SlotStatus.INVITED);
  });

  it('treats the expiry instant itself as expired', async () => {
    const { slotIds } = await fixture({ inviteExpiresAt: NOW });
    const { ctx } = context();

    const summary = await expireInvites(ctx);

    expect(summary.expired).toBe(1);
    expect(await statusOf(slotIds[0]!)).toBe(SlotStatus.EXPIRED);
  });

  it('never touches an INVITED slot that has no inviteExpiresAt', async () => {
    const { slotIds } = await fixture({ inviteExpiresAt: null });
    const { ctx } = context();

    const summary = await expireInvites(ctx);

    expect(summary).toEqual({ scanned: 0, expired: 0, truncated: false });

    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotIds[0]! } });
    expect(slot.status).toBe(SlotStatus.INVITED);
    expect(slot.inviteExpiresAt).toBeNull();
  });

  it('changes the status and nothing but the status (plus updatedAt)', async () => {
    const { slotIds } = await fixture({ inviteExpiresAt: laterInSeconds(-1) });
    const slotId = slotIds[0]!;

    // Populate every column an expiry must leave alone, so the comparison is not
    // vacuous: a rewrite that "helpfully" cleared a timestamp would be caught.
    await prisma.campaignCreatorSlot.update({
      where: { id: slotId },
      data: {
        contentUrl: 'https://example.test/video/1',
        submittedAt: laterInSeconds(-3_600),
        approvedAt: laterInSeconds(-3_000),
        currentTier: 'TIER_40',
        paidToDate: '120.00',
        currentViewCount: 1_234,
        lastViewCheckAt: laterInSeconds(-120),
        platform: 'YOUTUBE',
        contentId: 'video-1',
        isShort: true,
        isShortVerifiedAt: laterInSeconds(-3_000),
        viewTarget: 100_000,
        metric: 'VIEWS',
        settlementEndsAt: laterInSeconds(86_400),
      },
    });

    const before = (await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
    })) as unknown as Record<string, unknown>;

    await expireInvites(context().ctx);

    const after = (await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
    })) as unknown as Record<string, unknown>;

    expect(after.status).toBe(SlotStatus.EXPIRED);
    expect(changedColumns(before, after)).toEqual([]);
    // And explicitly: escrow and the immutable terms survive.
    expect(after.escrowAmount).toEqual(before.escrowAmount);
    expect(after.invitedAt).toEqual(before.invitedAt);
    expect(after.inviteExpiresAt).toEqual(before.inviteExpiresAt);
    expect(after.cancelledAt).toBeNull();
  });

  it('leaves accepted and in-progress slots alone even when their window has passed', async () => {
    const accepted = await fixture({ status: SlotStatus.ACCEPTED, inviteExpiresAt: laterInSeconds(-60) });
    const inProgress = await fixture({
      status: SlotStatus.IN_PROGRESS,
      inviteExpiresAt: laterInSeconds(-60),
    });
    const { ctx } = context();

    const summary = await expireInvites(ctx);

    expect(summary).toEqual({ scanned: 0, expired: 0, truncated: false });
    expect(await statusOf(accepted.slotIds[0]!)).toBe(SlotStatus.ACCEPTED);
    expect(await statusOf(inProgress.slotIds[0]!)).toBe(SlotStatus.IN_PROGRESS);
  });

  it('expires a soft-deleted INVITED slot: its escrow is still committed', async () => {
    // create-invite counts soft-deleted slots in committed escrow on purpose
    // ("escrow may already have been committed"), so excluding them here would
    // leave that budget committed forever with no state that explains it.
    const { slotIds } = await fixture({
      inviteExpiresAt: laterInSeconds(-1),
      deletedAt: laterInSeconds(-60),
    });
    const { ctx } = context();

    const summary = await expireInvites(ctx);

    expect(summary.expired).toBe(1);
    const slot = await prisma.campaignCreatorSlot.findUniqueOrThrow({ where: { id: slotIds[0]! } });
    expect(slot.status).toBe(SlotStatus.EXPIRED);
    // Expiry does not resurrect or re-delete the row.
    expect(slot.deletedAt).not.toBeNull();
  });

  it(
    'expires a large backlog in bounded batches',
    async () => {
      const count = 250;
      const { slotIds } = await fixture({ count, inviteExpiresAt: laterInSeconds(-1) });
      const { ctx } = context();

      const summary = await expireInvites(ctx);

      expect(summary).toEqual({ scanned: count, expired: count, truncated: false });

      const expired = await prisma.campaignCreatorSlot.count({
        where: { id: { in: slotIds }, status: SlotStatus.EXPIRED },
      });
      expect(expired).toBe(count);
    },
    120_000,
  );

  it('stops at its budget, reports truncation, and finishes the backlog next run', async () => {
    const { slotIds } = await fixture({ count: 3, inviteExpiresAt: laterInSeconds(-1) });
    const { ctx } = context();
    // Two rows per statement, one statement per run: the bound is exercised
    // without needing 2,001 fixture rows.
    const limits = { batchSize: 2, maxBatches: 1 };

    const first = await expireInvites(ctx, limits);
    expect(first).toEqual({ scanned: 2, expired: 2, truncated: true });

    const second = await expireInvites(ctx, limits);
    expect(second).toEqual({ scanned: 1, expired: 1, truncated: false });

    const expired = await prisma.campaignCreatorSlot.count({
      where: { id: { in: slotIds }, status: SlotStatus.EXPIRED },
    });
    expect(expired).toBe(3);
  });

  it('is idempotent: a second run expires nothing', async () => {
    await fixture({ inviteExpiresAt: laterInSeconds(-1) });
    const { ctx } = context();

    expect((await expireInvites(ctx)).expired).toBe(1);
    expect(await expireInvites(ctx)).toEqual({ scanned: 0, expired: 0, truncated: false });
  });

  it('skips a slot accepted between the select and the update', async () => {
    const { slotIds } = await fixture({ inviteExpiresAt: laterInSeconds(-1) });
    const slotId = slotIds[0]!;

    const db = dbWithRaceBeforeUpdate(async () => {
      // Exactly what the accept route writes, one instant before the CAS runs.
      await prisma.campaignCreatorSlot.update({
        where: { id: slotId },
        data: { status: SlotStatus.ACCEPTED, acceptedAt: NOW },
      });
    });

    const { ctx, recorder } = context(db);
    const summary = await expireInvites(ctx);

    // It was read, and it was not written.
    expect(summary).toEqual({ scanned: 1, expired: 0, truncated: false });
    expect(await statusOf(slotId)).toBe(SlotStatus.ACCEPTED);

    // The loss is logged as counts, not as a slot: no slotId in this line.
    const skipped = recorder.entries.find(
      (entry) => entry.msg === 'invites.expire: some candidates changed before the update',
    );
    expect(skipped?.fields).toEqual({ candidates: 1, expired: 0 });
  });

  it('uses the production bounds unless a caller narrows them', () => {
    expect(INVITE_EXPIRY_BATCH_SIZE).toBe(100);
    expect(INVITE_EXPIRY_MAX_BATCHES).toBe(20);
  });
});
