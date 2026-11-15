// apps/web/src/lib/slots/resolve-dispute.audit.test.ts
//
// Pure audit-trail tests for resolveDispute(): no database, no network, so they
// always run (they are NOT gated on RUN_DB_TESTS).
//
// These cover the gap this file closes: once the compare-and-swap has written
// the resolution, the function must log it and report it as applied even when
// the post-write re-read returns nothing or disagrees. Before, such a
// resolution could be reported as a refusal and never logged at all, because the
// audit line came after the re-read.
//
// Only Prisma is faked; the function under test is the real one.

import { Prisma, PrismaClient, SlotStatus } from '@repo/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveDispute } from './resolve-dispute';

const CANARY_REASON = 'CANARY_reason_5aa';
const SLOT_ID = 'slot_audit_1';
const OPERATOR = 'operator@example.com';
const DISPUTED_AT = new Date('2026-11-10T09:00:00.000Z');
const SETTLEMENT_ENDS_AT = new Date('2026-12-10T09:00:00.000Z');

const AUDIT_MESSAGE = '[slots] dispute resolved';
const MISMATCH_MESSAGE = '[slots] dispute resolved but the post-write re-read disagreed';

/** The first (pre-write) read: a DISPUTED slot holding a real dispute reason. */
function disputedRow() {
  return {
    id: SLOT_ID,
    status: SlotStatus.DISPUTED,
    settlementEndsAt: SETTLEMENT_ENDS_AT,
    disputedAt: DISPUTED_AT,
    escrowAmount: new Prisma.Decimal('1000.00'),
    paidToDate: new Prisma.Decimal('400.00'),
    // Carried on the row so any leak into a log argument or a result is caught.
    disputeReason: CANARY_REASON,
  };
}

/** The post-write read on the happy path: the resumption landed. */
function resumedRow() {
  return {
    id: SLOT_ID,
    status: SlotStatus.IN_PROGRESS,
    settlementEndsAt: new Date('2026-12-15T09:00:00.000Z'),
    disputedAt: DISPUTED_AT,
    disputeResolvedAt: new Date('2026-11-15T09:00:00.000Z'),
    escrowAmount: new Prisma.Decimal('1000.00'),
    paidToDate: new Prisma.Decimal('400.00'),
    disputeReason: CANARY_REASON,
  };
}

/** A PrismaClient whose two reads return `reads` in order and whose CAS wins. */
function fakePrisma(reads: unknown[]) {
  const findFirst = vi.fn();
  for (const read of reads) findFirst.mockResolvedValueOnce(read);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });

  return {
    prisma: { campaignCreatorSlot: { findFirst, updateMany } } as unknown as PrismaClient,
    findFirst,
    updateMany,
  };
}

/** Every argument the code passed to any console method, as one string. */
function captureConsole() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  return {
    info,
    warn,
    all: () => JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls, log.mock.calls]),
  };
}

function resolve(prisma: PrismaClient) {
  return resolveDispute(prisma, {
    slotId: SLOT_ID,
    outcome: 'RESUME',
    operator: OPERATOR,
    apply: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveDispute audit trail after a successful write', () => {
  it('reports applied and logs once when the post-write read returns null', async () => {
    const consoleCapture = captureConsole();
    const fake = fakePrisma([disputedRow(), null]);

    const result = await resolve(fake.prisma);

    expect(result.kind).toBe('applied');
    expect(result).toMatchObject({
      slotId: SLOT_ID,
      outcome: 'RESUME',
      operator: OPERATOR,
      newStatus: 'IN_PROGRESS',
    });

    expect(fake.updateMany).toHaveBeenCalledTimes(1);
    expect(consoleCapture.info).toHaveBeenCalledTimes(1);
    expect(consoleCapture.info).toHaveBeenCalledWith(AUDIT_MESSAGE, {
      slotId: SLOT_ID,
      outcome: 'RESUME',
      operator: OPERATOR,
      resolvedAt: expect.any(String),
    });
    expect(consoleCapture.warn).toHaveBeenCalledTimes(1);
    expect(consoleCapture.warn).toHaveBeenCalledWith(MISMATCH_MESSAGE, { slotId: SLOT_ID });

    expect(consoleCapture.all()).not.toContain(CANARY_REASON);
  });

  it('reports applied and logs once when the post-write read shows a re-raised dispute', async () => {
    const consoleCapture = captureConsole();
    const fake = fakePrisma([disputedRow(), { ...disputedRow(), status: SlotStatus.DISPUTED }]);

    const result = await resolve(fake.prisma);

    expect(result.kind).toBe('applied');
    expect(result).toMatchObject({
      slotId: SLOT_ID,
      outcome: 'RESUME',
      operator: OPERATOR,
      newStatus: 'IN_PROGRESS',
    });

    expect(fake.updateMany).toHaveBeenCalledTimes(1);
    expect(consoleCapture.info).toHaveBeenCalledTimes(1);
    expect(consoleCapture.info).toHaveBeenCalledWith(AUDIT_MESSAGE, {
      slotId: SLOT_ID,
      outcome: 'RESUME',
      operator: OPERATOR,
      resolvedAt: expect.any(String),
    });
    expect(consoleCapture.warn).toHaveBeenCalledTimes(1);
    expect(consoleCapture.warn).toHaveBeenCalledWith(MISMATCH_MESSAGE, { slotId: SLOT_ID });

    expect(consoleCapture.all()).not.toContain(CANARY_REASON);
  });

  it('logs once and does not warn when the post-write read agrees', async () => {
    const consoleCapture = captureConsole();
    const fake = fakePrisma([disputedRow(), resumedRow()]);

    const result = await resolve(fake.prisma);

    expect(result.kind).toBe('applied');
    expect(result).toMatchObject({
      slotId: SLOT_ID,
      outcome: 'RESUME',
      operator: OPERATOR,
      newStatus: 'IN_PROGRESS',
      resolvedAt: '2026-11-15T09:00:00.000Z',
    });

    expect(fake.updateMany).toHaveBeenCalledTimes(1);
    expect(consoleCapture.info).toHaveBeenCalledTimes(1);
    expect(consoleCapture.info).toHaveBeenCalledWith(AUDIT_MESSAGE, {
      slotId: SLOT_ID,
      outcome: 'RESUME',
      operator: OPERATOR,
      resolvedAt: expect.any(String),
    });
    expect(consoleCapture.warn).not.toHaveBeenCalled();

    expect(consoleCapture.all()).not.toContain(CANARY_REASON);
  });
});
