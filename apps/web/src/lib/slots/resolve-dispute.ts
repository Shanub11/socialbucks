// apps/web/src/lib/slots/resolve-dispute.ts
//
// Operator resolution of a disputed slot: DISPUTED -> IN_PROGRESS (resume) or
// DISPUTED -> CLOSED (close), per ADR-0004 D3 and D4.
//
// This module never moves money and never writes a PayoutEvent. Resolution only
// changes the slot's status and timestamps; returning unreleased escrow to the
// brand is out of scope until a payment partner exists, and CLOSED is not a
// freed-escrow status (the slot keeps counting its full escrow against the
// campaign budget).
//
// Rules:
// - The write is one compare-and-swap on scalar columns only: id, deletedAt
//   null, status DISPUTED, and disputedAt set to the exact value that was read.
//   A dispute re-raised between the read and the write therefore cannot be
//   resolved by a stale plan.
// - The audit line ('[slots] dispute resolved') is emitted immediately after the
//   compare-and-swap succeeds, before the post-write re-read, and exactly once.
//   A resolution that reached the database is never reported as a refusal; if
//   the re-read disagrees, the resolution is still reported as applied from the
//   computed values and a warning is logged instead. Ids and the operator only:
//   the dispute reason never reaches a log argument or a result.
// - The resolution timestamp must be at or after the dispute timestamp. The
//   slot_dispute_resolved_order CHECK enforces this in the database too; we
//   fail clearly before any write instead of surfacing a constraint error.
// - RESUME extends settlementEndsAt by exactly the time the slot spent
//   disputed (resolvedAt - disputedAt) and nothing else (ADR-0004 D4).
// - Operator identity currently lives only in the log line: the slot row has no
//   column for it, because ADR-0004 keeps only the latest dispute on the row
//   until a dispute-history table is justified.
// - CLOSE is terminal by policy: there is no reopen tool.
// - The dispute reason is never read, logged or returned.
//
// Imports are '@repo/database' and relative paths only, so the CLI script can
// load this file through tsx without the '@/' alias.

import { PrismaClient, SlotStatus } from '@repo/database';

export const RESOLUTION_OUTCOMES = ['RESUME', 'CLOSE'] as const;
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

export const MAX_OPERATOR_LENGTH = 100;

export interface ResolveDisputeInput {
  slotId: string;
  outcome: ResolutionOutcome;
  operator: string;
  apply: boolean;
  now?: Date;
  expectedDisputedAt?: Date;
}

export type RefusalReason =
  | 'invalid_input'
  | 'slot_not_found'
  | 'not_disputed'
  | 'missing_settlement_window'
  | 'clock_before_dispute'
  | 'nothing_to_close'
  | 'dispute_changed'
  | 'slot_changed';

export type ResolveDisputeResult =
  | {
      kind: 'planned' | 'applied';
      slotId: string;
      outcome: ResolutionOutcome;
      operator: string;
      disputedAt: string;
      resolvedAt: string;
      newStatus: 'IN_PROGRESS' | 'CLOSED';
      settlementEndsAt: string | null;
      newSettlementEndsAt: string | null;
      extensionMs: number | null;
      escrowAmount: string;
      paidToDate: string;
      unreleasedAmount: string;
    }
  | { kind: 'refused'; reason: RefusalReason; message: string };

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const SLOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Control characters: includes newline, carriage return and tab. */
const CONTROL_CHARS = /\p{Cc}/u;

/** Bidi overrides, which can disguise an operator name in a log line. */
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/;

const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  invalid_input: 'Invalid input. Check the slot id, outcome and operator name.',
  slot_not_found: 'Slot not found.',
  not_disputed: 'Slot is not DISPUTED, so there is nothing to resolve.',
  missing_settlement_window: 'Slot has no settlement window; refusing to guess one.',
  clock_before_dispute: 'Resolution time is before the dispute was raised.',
  nothing_to_close: 'Slot has no unreleased escrow to close.',
  dispute_changed: 'The dispute changed since it was read. Re-read and retry.',
  slot_changed: 'The slot changed while resolving. Re-read and retry.',
};

function refused(reason: RefusalReason): ResolveDisputeResult {
  return { kind: 'refused', reason, message: REFUSAL_MESSAGES[reason] };
}

interface ValidatedInput {
  slotId: string;
  outcome: ResolutionOutcome;
  operator: string;
  apply: boolean;
  now?: Date;
  expectedDisputedAt?: Date;
}

function normalizeOperator(raw: string): string | null {
  const normalized = raw.normalize('NFC').trim();
  if (Array.from(normalized).length === 0) return null;
  if (Array.from(normalized).length > MAX_OPERATOR_LENGTH) return null;
  if (CONTROL_CHARS.test(normalized)) return null;
  if (BIDI_OVERRIDES.test(normalized)) return null;
  return normalized;
}

/** Returns null when the input is unusable; the caller refuses generically. */
function validateInput(input: ResolveDisputeInput): ValidatedInput | null {
  if (typeof input.slotId !== 'string' || !SLOT_ID_PATTERN.test(input.slotId)) {
    return null;
  }
  if (!RESOLUTION_OUTCOMES.includes(input.outcome)) {
    return null;
  }
  if (typeof input.operator !== 'string') {
    return null;
  }
  const operator = normalizeOperator(input.operator);
  if (operator === null) {
    return null;
  }
  if (typeof input.apply !== 'boolean') {
    return null;
  }
  if (input.now !== undefined && Number.isNaN(input.now.getTime())) {
    return null;
  }
  if (
    input.expectedDisputedAt !== undefined &&
    Number.isNaN(input.expectedDisputedAt.getTime())
  ) {
    return null;
  }

  return {
    slotId: input.slotId,
    outcome: input.outcome,
    operator,
    apply: input.apply,
    now: input.now,
    expectedDisputedAt: input.expectedDisputedAt,
  };
}

// ---------------------------------------------------------------------------
// resolveDispute
// ---------------------------------------------------------------------------

/**
 * Resolves one disputed slot.
 *
 * Returns a discriminated result instead of throwing for expected conditions.
 * With `apply: false` nothing is written and nothing is logged; the caller gets
 * a 'planned' result it can show to an operator.
 *
 * @param prisma - Prisma client (injected so the CLI owns connection lifecycle)
 * @param input  - validated below; `now` and `expectedDisputedAt` are for tests
 */
export async function resolveDispute(
  prisma: PrismaClient,
  input: ResolveDisputeInput,
): Promise<ResolveDisputeResult> {
  // 1. Validate without throwing. Refusals never echo the submitted text.
  const validated = validateInput(input);
  if (validated === null) return refused('invalid_input');

  // 2. Read the slot. A soft-deleted slot is not found.
  const slot = await prisma.campaignCreatorSlot.findFirst({
    where: { id: validated.slotId, deletedAt: null },
    select: {
      id: true,
      status: true,
      settlementEndsAt: true,
      disputedAt: true,
      escrowAmount: true,
      paidToDate: true,
    },
  });
  if (slot === null) return refused('slot_not_found');

  // 3. Only a DISPUTED slot with a dispute timestamp can be resolved.
  if (slot.status !== SlotStatus.DISPUTED || slot.disputedAt === null) {
    return refused('not_disputed');
  }

  // 4. A caller that planned against a specific dispute must not apply to a
  //    later one.
  if (
    validated.expectedDisputedAt !== undefined &&
    validated.expectedDisputedAt.getTime() !== slot.disputedAt.getTime()
  ) {
    return refused('dispute_changed');
  }

  // 5. A resolution before the dispute is impossible; the CHECK would reject
  //    it, so fail clearly first.
  const resolvedAt = validated.now ?? new Date();
  if (resolvedAt.getTime() < slot.disputedAt.getTime()) {
    return refused('clock_before_dispute');
  }

  // 6. Compute the new state. Money is Decimal arithmetic, never floats.
  const unreleased = slot.escrowAmount.minus(slot.paidToDate);
  let newStatus: 'IN_PROGRESS' | 'CLOSED';
  let newSettlementEndsAt: Date | null = null;
  let extensionMs: number | null = null;

  if (validated.outcome === 'RESUME') {
    if (slot.settlementEndsAt === null) {
      return refused('missing_settlement_window');
    }
    // ADR-0004 D4: extend by the time spent disputed, and nothing else.
    extensionMs = resolvedAt.getTime() - slot.disputedAt.getTime();
    newSettlementEndsAt = new Date(slot.settlementEndsAt.getTime() + extensionMs);
    newStatus = 'IN_PROGRESS';
  } else {
    // CLOSED means the window ended with escrow still unreleased (D2).
    if (unreleased.lessThanOrEqualTo(0)) {
      return refused('nothing_to_close');
    }
    newStatus = 'CLOSED';
  }

  // 7. The unreleased amount is always reported.
  const planned: ResolveDisputeResult = {
    kind: 'planned',
    slotId: slot.id,
    outcome: validated.outcome,
    operator: validated.operator,
    disputedAt: slot.disputedAt.toISOString(),
    resolvedAt: resolvedAt.toISOString(),
    newStatus,
    settlementEndsAt:
      slot.settlementEndsAt === null ? null : slot.settlementEndsAt.toISOString(),
    newSettlementEndsAt:
      newSettlementEndsAt === null ? null : newSettlementEndsAt.toISOString(),
    extensionMs,
    escrowAmount: slot.escrowAmount.toFixed(2),
    paidToDate: slot.paidToDate.toFixed(2),
    unreleasedAmount: unreleased.toFixed(2),
  };

  // 8. Dry run: nothing is written and nothing is logged.
  if (!validated.apply) return planned;

  // 9. Compare-and-swap. The WHERE clause deliberately uses only scalar
  //    columns of the slot row, and pins disputedAt to the exact value read
  //    above: a slot that was re-disputed (or resolved) since then matches zero
  //    rows, so a stale plan can never resolve a newer dispute.
  const where = {
    id: slot.id,
    deletedAt: null,
    status: SlotStatus.DISPUTED,
    disputedAt: slot.disputedAt,
  };

  const result =
    validated.outcome === 'RESUME'
      ? await prisma.campaignCreatorSlot.updateMany({
          where,
          data: {
            status: SlotStatus.IN_PROGRESS,
            settlementEndsAt: newSettlementEndsAt,
            disputeResolvedAt: resolvedAt,
          },
        })
      : await prisma.campaignCreatorSlot.updateMany({
          where,
          data: {
            status: SlotStatus.CLOSED,
            closedAt: resolvedAt,
            disputeResolvedAt: resolvedAt,
          },
        });

  if (result.count === 0) return refused('slot_changed');

  // 10. Audit line. The write committed, so this is emitted immediately - before
  // the post-write re-read - and exactly once per resolution. Emitting it later
  // would let a failed or disagreeing read report a committed resolution as a
  // refusal that never happened.
  console.info('[slots] dispute resolved', {
    slotId: slot.id,
    outcome: validated.outcome,
    operator: validated.operator,
    resolvedAt: resolvedAt.toISOString(),
  });

  // 11. Report what is actually stored, not what was computed.
  const stored = await prisma.campaignCreatorSlot.findFirst({
    where: { id: slot.id, deletedAt: null },
    select: {
      id: true,
      status: true,
      settlementEndsAt: true,
      disputedAt: true,
      disputeResolvedAt: true,
      escrowAmount: true,
      paidToDate: true,
    },
  });
  if (
    stored === null ||
    stored.disputedAt === null ||
    (stored.status !== SlotStatus.IN_PROGRESS &&
      stored.status !== SlotStatus.CLOSED)
  ) {
    // The write succeeded; only the read-back is untrustworthy. Report the
    // resolution from the values computed above rather than denying it happened.
    console.warn('[slots] dispute resolved but the post-write re-read disagreed', {
      slotId: slot.id,
    });
    return { ...planned, kind: 'applied' };
  }

  const appliedSettlementEndsAt =
    validated.outcome === 'RESUME' ? slot.settlementEndsAt : stored.settlementEndsAt;
  const appliedNewSettlementEndsAt =
    validated.outcome === 'RESUME' ? stored.settlementEndsAt : null;
  const appliedExtensionMs =
    appliedSettlementEndsAt !== null && appliedNewSettlementEndsAt !== null
      ? appliedNewSettlementEndsAt.getTime() - appliedSettlementEndsAt.getTime()
      : null;

  const applied: ResolveDisputeResult = {
    kind: 'applied',
    slotId: stored.id,
    outcome: validated.outcome,
    operator: validated.operator,
    disputedAt: stored.disputedAt.toISOString(),
    resolvedAt: (stored.disputeResolvedAt ?? resolvedAt).toISOString(),
    newStatus: stored.status === SlotStatus.CLOSED ? 'CLOSED' : 'IN_PROGRESS',
    settlementEndsAt:
      appliedSettlementEndsAt === null
        ? null
        : appliedSettlementEndsAt.toISOString(),
    newSettlementEndsAt:
      appliedNewSettlementEndsAt === null
        ? null
        : appliedNewSettlementEndsAt.toISOString(),
    extensionMs: appliedExtensionMs,
    escrowAmount: stored.escrowAmount.toFixed(2),
    paidToDate: stored.paidToDate.toFixed(2),
    unreleasedAmount: stored.escrowAmount.minus(stored.paidToDate).toFixed(2),
  };

  return applied;
}
