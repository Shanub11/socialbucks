// apps/web/src/lib/settlement/tiers.ts
//
// Pure domain logic for milestone tier progression.
// No DB, no network. All arithmetic is BigInt (D4).
//
// D4 — Rounding rules:
//   cumBps:    BASELINE=2000, TIER_40=4000, TIER_70=7000, TIER_100=10000
//   cumAmount  = floor(escrowMinor * cumBps / 10000)
//               except TIER_100 = escrowMinor exactly (absorbs remainder)
//   tierAmount = cumAmount(tier) - cumAmount(prevTier)
//   threshold  = ceil(viewTarget * cumBps / 10000)
//   crossed    = billableViews >= thresholdViews

import { MilestoneTier, SocialPlatform } from '@repo/database';
import { Prisma } from '@repo/database';
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;;
import {
  bigintCeilDiv,
  bigintFloorDiv,
  fromMinorUnits,
  toMinorUnits,
  MoneyError,
} from './money';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TierError';
  }
}

// ---------------------------------------------------------------------------
// D4 — Cumulative basis points per tier
// ---------------------------------------------------------------------------

/** Cumulative basis points (out of 10 000) released through each tier. */
const CUM_BPS: Record<MilestoneTier, bigint> = {
  [MilestoneTier.BASELINE]: 2000n,
  [MilestoneTier.TIER_40]:  4000n,
  [MilestoneTier.TIER_70]:  7000n,
  [MilestoneTier.TIER_100]: 10000n,
};

/** Ordered tier list — ascending from lowest to highest. */
export const TIER_ORDER: readonly MilestoneTier[] = [
  MilestoneTier.BASELINE,
  MilestoneTier.TIER_40,
  MilestoneTier.TIER_70,
  MilestoneTier.TIER_100,
] as const;

const BPS_DENOMINATOR = 10000n;

// ---------------------------------------------------------------------------
// D2 — Platform → billable metric mapping
//
// One function, one mapping. Flipping a platform's metric is a one-line change
// inside the switch. The ledger stores the metric name (string) so the mapping
// at time-of-trigger is preserved even if we change it later.
// ---------------------------------------------------------------------------

/** The metric name stored in PayoutEvent.billableMetric. */
export type BillableMetricName = 'engagedViews' | 'views';

/**
 * Returns the billable metric name for a given platform (D2).
 *
 * YouTube → engagedViews
 * Instagram → views
 *
 * Exhaustive switch: adding a new SocialPlatform without updating this
 * function is a compile error.
 */
export function getBillableMetric(platform: SocialPlatform): BillableMetricName {
  switch (platform) {
    case SocialPlatform.YOUTUBE:
      return 'engagedViews';
    case SocialPlatform.INSTAGRAM:
      return 'views';
    default: {
      // Exhaustiveness check — TypeScript narrows platform to `never` here.
      const _exhaustive: never = platform;
      throw new TierError(
        `Unknown platform: ${String(_exhaustive)}. Add a case to getBillableMetric().`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// View validation
// ---------------------------------------------------------------------------

/**
 * Validates that billableViews is a non-negative integer.
 * Zero is valid (no tiers crossed). Negative or non-integer throws.
 */
export function validateBillableViews(views: number): void {
  if (!Number.isFinite(views)) {
    throw new TierError(`billableViews must be a finite number, got ${views}`);
  }
  if (Number.isNaN(views)) {
    throw new TierError('billableViews is NaN');
  }
  if (!Number.isInteger(views)) {
    throw new TierError(
      `billableViews must be an integer, got ${views}. ` +
      'Analytics APIs return whole-number view counts.',
    );
  }
  if (views < 0) {
    throw new TierError(`billableViews must be >= 0, got ${views}`);
  }
}

/**
 * Validates that viewTarget is a positive integer > 0.
 * Zero or negative → never settles (D1).
 */
export function validateViewTarget(target: number): void {
  if (!Number.isFinite(target) || Number.isNaN(target)) {
    throw new TierError(`viewTarget must be a finite integer, got ${target}`);
  }
  if (!Number.isInteger(target)) {
    throw new TierError(`viewTarget must be an integer, got ${target}`);
  }
  if (target <= 0) {
    throw new TierError(`viewTarget must be > 0, got ${target}. Slot never settles.`);
  }
}

// ---------------------------------------------------------------------------
// D4 — Tier threshold calculation
// ---------------------------------------------------------------------------

/**
 * Returns the minimum billable view count that crosses the given tier.
 *
 * thresholdViews = ceil(viewTarget * cumBps / 10000)
 *
 * All arithmetic is BigInt — no floats.
 */
export function getTierThreshold(tier: MilestoneTier, viewTarget: number): number {
  validateViewTarget(viewTarget);
  const cumBps = CUM_BPS[tier];
  const result = bigintCeilDiv(BigInt(viewTarget), cumBps, BPS_DENOMINATOR);
  return Number(result);
}

// ---------------------------------------------------------------------------
// D4 — Tier amount calculation
// ---------------------------------------------------------------------------

/**
 * Cumulative amount released through the given tier (in minor units).
 *
 * cumAmount(TIER_100) = escrowMinor exactly (absorbs remainder).
 * cumAmount(other)    = floor(escrowMinor * cumBps / 10000)
 */
function cumulativeAmountMinor(tier: MilestoneTier, escrowMinor: bigint): bigint {
  if (tier === MilestoneTier.TIER_100) {
    return escrowMinor; // Final tier absorbs remainder exactly.
  }
  const cumBps = CUM_BPS[tier];
  return bigintFloorDiv(escrowMinor, cumBps, BPS_DENOMINATOR);
}

/**
 * Amount released for exactly this tier (not cumulative), in minor units.
 *
 * tierAmount = cumAmount(tier) - cumAmount(prevTier)
 *
 * BASELINE's prevTier is 0 (nothing released before).
 */
function tierAmountMinor(tier: MilestoneTier, escrowMinor: bigint): bigint {
  const cumThis = cumulativeAmountMinor(tier, escrowMinor);
  const tierIndex = TIER_ORDER.indexOf(tier);
  if (tierIndex === 0) {
    return cumThis; // BASELINE: no previous tier.
  }
  const prevTier = TIER_ORDER[tierIndex - 1];
  // prevTier is always defined when tierIndex > 0
  const cumPrev = cumulativeAmountMinor(prevTier!, escrowMinor);
  return cumThis - cumPrev;
}

// ---------------------------------------------------------------------------
// Public tier computation API
// ---------------------------------------------------------------------------

export interface TierResult {
  tier: MilestoneTier;
  /** Per-tier release amount as Decimal (2dp), for storage in PayoutEvent. */
  amount: Decimal;
  /** Per-tier release amount in minor units, for internal arithmetic. */
  amountMinor: bigint;
  /** The threshold view count that this tier crossing required. */
  thresholdViews: number;
}

/**
 * Computes all tiers that billableViews crosses, starting from (not including)
 * the highest tier already in the ledger (alreadyPaidTiers).
 *
 * Returns an ordered list of TierResult for each newly-crossed tier.
 * Returns [] if no new tier is crossed (NO_CHANGE).
 *
 * D4: amounts always sum to escrowAmount for a full progression.
 *
 * @param escrowAmount   - Slot escrow as Prisma Decimal (2dp).
 * @param viewTarget     - Slot view target (positive integer).
 * @param billableViews  - Observed views (non-negative integer).
 * @param alreadyPaid    - Tiers already present in the ledger (may be empty).
 */
export function computeNewTiers(
  escrowAmount: Decimal,
  viewTarget: number,
  billableViews: number,
  alreadyPaid: ReadonlySet<MilestoneTier>,
): TierResult[] {
  validateViewTarget(viewTarget);
  validateBillableViews(billableViews);

  const escrowMinor = toMinorUnits(escrowAmount);
  if (escrowMinor <= 0n) {
    throw new MoneyError(`escrowAmount must be > 0, got ${escrowAmount.toString()}`);
  }

  const results: TierResult[] = [];

  for (const tier of TIER_ORDER) {
    if (alreadyPaid.has(tier)) {
      // Already in ledger — skip (monotonic-forward-only, D4 rule 1).
      continue;
    }

    const threshold = getTierThreshold(tier, viewTarget);
    if (billableViews < threshold) {
      // Views haven't reached this tier's threshold yet.
      // Since tiers are ordered, no subsequent tier will be crossed either.
      break;
    }

    const amountMinor = tierAmountMinor(tier, escrowMinor);
    results.push({
      tier,
      amount: fromMinorUnits(amountMinor),
      amountMinor,
      thresholdViews: threshold,
    });
  }

  return results;
}

/**
 * Verifies that the sum of all tier amounts equals escrowAmount exactly.
 *
 * This is an internal consistency check used in tests. Returns the
 * total minor units sum for inspection.
 */
export function sumAllTierAmountsMinor(escrowAmount: Decimal): bigint {
  const escrowMinor = toMinorUnits(escrowAmount);
  let total = 0n;
  for (const tier of TIER_ORDER) {
    total += tierAmountMinor(tier, escrowMinor);
  }
  return total;
}

/**
 * Returns the highest tier present in a set of paid tiers.
 * Returns null if the set is empty.
 */
export function highestPaidTier(paid: ReadonlySet<MilestoneTier>): MilestoneTier | null {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_ORDER[i]!;
    if (paid.has(tier)) return tier;
  }
  return null;
}
