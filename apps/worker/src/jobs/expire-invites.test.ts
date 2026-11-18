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

/**
 * One comparable string per value, so a Date, a Decimal and a plain string can
 * never compare equal by accident:
 *
 *   - Date     -> its epoch milliseconds (a fresh Date object is still equal);
 *   - Decimal  -> its string form (Prisma hands back Decimal objects, and
 *                 `120.00` vs `120` are the same number but different strings,
 *                 which is what we want: the column is exact);
 *   - null     -> 'null', and stays distinguishable from the string 'null'.
 */
function comparable(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (typeof value === 'object' && typeof (value as { toFixed?: unknown }).toFixed === 'function') {
    return `decimal:${(value as { toString(): string }).toString()}`;
  }
  return `${typeof value}:${String(value)}`;
}

/** The two columns an expiry is allowed to write. */
const EXPECTED_CHANGES = new Set(['status', 'updatedAt']);

/**
 * Every key of both rows, except the two above, whose value differs. The key
 * list is derived from the rows rather than written out, so a column added to
 * the schema later is compared without editing this file.
 */
function changedColumns(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !EXPECTED_CHANGES.has(key) && comparable(before[key]) !== comparable(after[key]));
}

/** The columns that are still null (or missing) in a row. */
function nullColumns(row: Record<string, unknown>): string[] {
  return Object.keys(row).filter((key) => row[key] === null || row[key] === undefined);
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
    // Cleanup runs whatever the test did - an assertion failure included. Every
    // fixture is attempted even if one removal fails, and the first failure is
    // rethrown at the end so a leaked row is never silent.
    const pending = created.splice(0).reverse();
    const failures: unknown[] = [];

    for (const made of pending) {
      try {
        await removeFixture(made);
      } catch (error) {
        failures.push(error);
      }
    }

    await prisma.$disconnect();

    if (failures.length > 0) throw failures[0];
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
    const { slotIds, userIds } = await fixture({
      inviteExpiresAt: laterInSeconds(-1),
      withSocialAccount: true,
    });
    const slotId = slotIds[0]!;

    // Populate every nullable column an expiry must leave alone with a value that
    // satisfies the table's CHECK constraints, so the comparison is not vacuous:
    // a rewrite that "helpfully" cleared a timestamp, a URL or the escrow terms
    // would be caught. Two of these are pinned by constraints:
    //
    //   slot_metric_known          metric is NULL or IN ('engagedViews','views')
    //   slot_paid_within_escrow   0 <= paidToDate <= escrowAmount (500.00 here)
    //
    // 'VIEWS' was the value that failed this setup with SQLSTATE 23514: the
    // constraint's vocabulary is the lowerCamel pair the migration backfilled.
    await prisma.campaignCreatorSlot.update({
      where: { id: slotId },
      data: {
        contentUrl: 'https://www.youtube.com/watch?v=fixture-video-1',
        submittedAt: laterInSeconds(-3_600),
        approvedAt: laterInSeconds(-3_000),
        currentTier: 'TIER_40',
        paidToDate: '120.00',
        currentViewCount: 1_234,
        lastViewCheckAt: laterInSeconds(-120),
        platform: 'YOUTUBE',
        contentId: 'fixture-video-1',
        isShort: true,
        isShortVerifiedAt: laterInSeconds(-3_000),
        viewTarget: 100_000,
        metric: 'engagedViews',
        // Lifecycle stamps after the invite: none of them is required by the
        // INVITED state, and every one of them must survive the expiry untouched.
        acceptedAt: laterInSeconds(-7_200),
        declinedAt: laterInSeconds(-7_200),
        reviewDueAt: laterInSeconds(-3_000),
        rejectedAt: laterInSeconds(-7_200),
        rejectionReason: 'The submission did not match the campaign brief.',
        settlementEndsAt: laterInSeconds(86_400),
        cancelledAt: laterInSeconds(-7_200),
        closedAt: laterInSeconds(-7_200),
        // Dispute record: slot_dispute_resolved_order requires disputedAt to be
        // set and disputeResolvedAt to be at or after it.
        disputedAt: laterInSeconds(-8_000),
        disputeReason: 'Disputed for fixture coverage.',
        disputeResolvedAt: laterInSeconds(-7_000),
        disputeRaisedByUserId: userIds[0]!,
        deletedAt: laterInSeconds(-60),
      },
    });

    const beforeRow = (await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
    })) as unknown as Record<string, unknown>;

    // Non-vacuity: every column is non-null, so "nothing else changed" is a claim
    // about real values rather than about a row of NULLs.
    expect(nullColumns(beforeRow)).toEqual([]);

    await expireInvites(context().ctx);

    const afterRow = (await prisma.campaignCreatorSlot.findUniqueOrThrow({
      where: { id: slotId },
    })) as unknown as Record<string, unknown>;

    expect(afterRow.status).toBe(SlotStatus.EXPIRED);
    expect(changedColumns(beforeRow, afterRow)).toEqual([]);

    // The one column that is allowed to move did move, forwards.
    const beforeUpdatedAt = beforeRow.updatedAt as Date;
    const afterUpdatedAt = afterRow.updatedAt as Date;
    expect(afterUpdatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdatedAt.getTime());
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
