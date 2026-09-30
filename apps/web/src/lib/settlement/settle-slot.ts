// apps/web/src/lib/settlement/settle-slot.ts
//
// settleSlot() — internal settlement service (D6: no HTTP surface, no scheduler).
//
// Implements the full state machine described in ADR-0002:
//   Step 1. Eligibility check (fail-closed)
//   Step 2. Fetch metrics OUTSIDE DB transaction (network call)
//   Step 3. Serializable DB transaction with retry on P2034
//
// This module never logs tokens or raw settlement JSON.
// Logs carry slotId and outcome only.
//
// Node-only (imports crypto via secret-box.ts, Prisma).

import { MilestoneTier, SocialPlatform, SlotStatus, PrismaClient } from '@repo/database';
import { Prisma } from '@repo/database';
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;;
import { computeNewTiers, getBillableMetric, TIER_ORDER } from './tiers';
import { assertTwoDecimalCurrency, fromMinorUnits, toMinorUnits } from './money';

// ---------------------------------------------------------------------------
// Result discriminated union
// ---------------------------------------------------------------------------

export type SettleOutcome =
  | { status: 'ADVANCED';               newTiers: MilestoneTier[]; paidToDate: Decimal }
  | { status: 'NO_CHANGE';              reason: 'no_new_tiers' }
  | { status: 'SKIPPED_NOT_ELIGIBLE';   reason: SkippedReason }
  | { status: 'HELD_NO_DATA';           reason: 'no_analytics_data' };

export type SkippedReason =
  | 'slot_not_in_progress'
  | 'slot_deleted'
  | 'platform_null'
  | 'content_id_null'
  | 'social_account_null'
  | 'view_target_invalid'
  | 'social_account_revoked'
  | 'social_account_no_token'
  | 'youtube_not_short';

// ---------------------------------------------------------------------------
// Dependency-injection types (allow faking in tests)
// ---------------------------------------------------------------------------

/**
 * The billable metric extracted from a platform's analytics response.
 * Stored in PayoutEvent alongside the raw settlement snapshot.
 */
export interface MetricsResult {
  /** The value of the platform's billable metric (D2). */
  billableViews: number;
  /** The name of the metric used (e.g. 'engagedViews'). */
  billableMetric: string;
  /** Raw analytics snapshot for settlementJson (D8). */
  settlementSnapshot: unknown;
}

/**
 * Injected analytics provider. Real adapters are in ./adapters/.
 * Only the MetricsProvider is faked in tests — never the DB.
 */
export interface MetricsProvider {
  fetchMetrics(params: {
    platform: SocialPlatform;
    contentId: string;
    /** ISO 8601 date string — from slot.approvedAt */
    startDate: string;
    /** ISO 8601 date string — today UTC */
    endDate: string;
    /** Decrypted access token */
    accessToken: string;
  }): Promise<MetricsResult>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by the Instagram adapter when the shape doesn't fit the engine. */
export class UnsupportedPlatformError extends Error {
  constructor(platform: SocialPlatform) {
    super(
      `Platform ${platform} is not yet supported by the metrics provider. ` +
      'Implement an adapter before enabling settlement for this platform.',
    );
    this.name = 'UnsupportedPlatformError';
  }
}

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementError';
  }
}

// ---------------------------------------------------------------------------
// Retry helper for Prisma P2034 (serialization failure)
// ---------------------------------------------------------------------------

const MAX_TX_RETRIES = 3;

async function withSerializableRetry<T>(
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // P2034 = "Transaction failed due to a write conflict or a deadlock.
      // Please retry your transaction"
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'P2034'
      ) {
        lastError = err;
        // Jitter: 50–200 ms
        const jitterMs = 50 + Math.floor(Math.random() * 150);
        await new Promise((resolve) => setTimeout(resolve, jitterMs));
        continue;
      }
      throw err; // Non-retryable error — rethrow immediately
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function todayUTC(): string {
  return toISODate(new Date());
}

// ---------------------------------------------------------------------------
// settleSlot
// ---------------------------------------------------------------------------

/**
 * Settles a single CampaignCreatorSlot by:
 *   1. Checking eligibility (fail-closed on any missing/unverified input)
 *   2. Fetching metrics OUTSIDE the DB transaction
 *   3. Running a Serializable transaction to advance tiers idempotently
 *
 * Returns a discriminated SettleOutcome — never throws for expected conditions.
 * Throws (and lets the caller retry later) only for unexpected errors from
 * the analytics provider or from a non-P2034 DB error.
 *
 * @param slotId   - CampaignCreatorSlot.id
 * @param prisma   - Prisma client (injected for testability)
 * @param metrics  - MetricsProvider (injected; only this is faked in tests)
 */
export async function settleSlot(
  slotId: string,
  prisma: PrismaClient,
  metrics: MetricsProvider,
): Promise<SettleOutcome> {
  // -------------------------------------------------------------------------
  // Step 1 — Eligibility check (read outside transaction, fail-closed)
  // -------------------------------------------------------------------------

  const slot = await prisma.campaignCreatorSlot.findUnique({
    where: { id: slotId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      platform: true,
      contentId: true,
      socialAccountId: true,
      isShort: true,
      viewTarget: true,
      approvedAt: true,
      escrowAmount: true,
      campaign: {
        select: { currency: true },
      },
      socialAccount: {
        select: {
          tokenCiphertext: true,
          revokedAt: true,
          platform: true,
        },
      },
    },
  });

  if (!slot) {
    // Slot doesn't exist — not an expected case, throw so caller can alert
    throw new SettlementError(`Slot ${slotId} not found`);
  }

  // Only IN_PROGRESS slots settle (D9)
  if (slot.status !== SlotStatus.IN_PROGRESS) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'slot_not_in_progress' };
  }

  if (slot.deletedAt !== null) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'slot_deleted' };
  }

  // All identity fields must be present (D7)
  if (slot.platform === null) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'platform_null' };
  }
  if (slot.contentId === null) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'content_id_null' };
  }
  if (slot.socialAccountId === null) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'social_account_null' };
  }

  // viewTarget must be a positive integer (D1)
  if (slot.viewTarget === null || slot.viewTarget <= 0) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'view_target_invalid' };
  }

  // D3 — YOUTUBE: isShort must be exactly true (fail-closed)
  if (slot.platform === SocialPlatform.YOUTUBE) {
    if (slot.isShort !== true) {
      // null or false → HELD, no writes
      return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'youtube_not_short' };
    }
  }

  // SocialAccount must be active (revokedAt null) and have a token
  const sa = slot.socialAccount;
  if (!sa) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'social_account_null' };
  }
  if (sa.revokedAt !== null) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'social_account_revoked' };
  }
  if (!sa.tokenCiphertext) {
    return { status: 'SKIPPED_NOT_ELIGIBLE', reason: 'social_account_no_token' };
  }

  // D10 — assert 2-decimal currency (throws if not supported)
  assertTwoDecimalCurrency(slot.campaign.currency);

  // -------------------------------------------------------------------------
  // Step 2 — Fetch metrics OUTSIDE the DB transaction (D3/D6 note)
  // -------------------------------------------------------------------------

  const startDate = slot.approvedAt
    ? toISODate(slot.approvedAt)
    : '2020-01-01'; // fallback if approvedAt not set

  let metricsResult: MetricsResult;
  try {
    metricsResult = await metrics.fetchMetrics({
      platform: slot.platform,
      contentId: slot.contentId,
      startDate,
      endDate: todayUTC(),
      accessToken: sa.tokenCiphertext, // encrypted; adapter decrypts it
    });
  } catch (err) {
    // OAuthHttpError with status 404 → no data yet → HELD_NO_DATA
    if (
      err instanceof Error &&
      'status' in err &&
      (err as { status?: number }).status === 404
    ) {
      return { status: 'HELD_NO_DATA', reason: 'no_analytics_data' };
    }
    // Any other error → rethrow; caller retries later
    throw err;
  }

  const { billableViews, billableMetric, settlementSnapshot } = metricsResult;

  // -------------------------------------------------------------------------
  // Step 3 — Serializable transaction with retry on P2034
  // -------------------------------------------------------------------------

  const capturedSlotId = slot.id;
  const capturedPlatform = slot.platform;
  const capturedContentId = slot.contentId;
  const capturedViewTarget = slot.viewTarget;
  const capturedCurrency = slot.campaign.currency;

  return withSerializableRetry(async () => {
    return prisma.$transaction(
      async (tx) => {
        // 3a. Re-read slot inside the transaction (a dispute may have arrived)
        const freshSlot = await tx.campaignCreatorSlot.findUnique({
          where: { id: capturedSlotId },
          select: {
            status: true,
            deletedAt: true,
            platform: true,
            contentId: true,
            socialAccountId: true,
            viewTarget: true,
            isShort: true,
            escrowAmount: true,
          },
        });

        if (!freshSlot || freshSlot.status !== SlotStatus.IN_PROGRESS || freshSlot.deletedAt !== null) {
          // Slot changed since step 1 (disputed, cancelled, etc.) — abort cleanly
          return { status: 'SKIPPED_NOT_ELIGIBLE' as const, reason: 'slot_not_in_progress' as const };
        }

        // Re-check all identity fields inside tx (paranoia)
        if (
          freshSlot.platform === null ||
          freshSlot.contentId === null ||
          freshSlot.socialAccountId === null ||
          freshSlot.viewTarget === null ||
          freshSlot.viewTarget <= 0
        ) {
          return { status: 'SKIPPED_NOT_ELIGIBLE' as const, reason: 'platform_null' as const };
        }

        // D3 re-check inside tx
        if (capturedPlatform === SocialPlatform.YOUTUBE && freshSlot.isShort !== true) {
          return { status: 'SKIPPED_NOT_ELIGIBLE' as const, reason: 'youtube_not_short' as const };
        }

        // 3b. Read tiers already in the ledger (source of truth, D10)
        const existingEvents = await tx.payoutEvent.findMany({
          where: { slotId: capturedSlotId },
          select: { tier: true, amount: true },
        });

        const alreadyPaidSet = new Set(existingEvents.map((e) => e.tier));

        // 3c. Compute newly-crossed tiers
        const newTiers = computeNewTiers(
          freshSlot.escrowAmount,
          freshSlot.viewTarget,
          billableViews,
          alreadyPaidSet,
        );

        if (newTiers.length === 0) {
          // No new tiers — update view count cache only
          await tx.campaignCreatorSlot.update({
            where: { id: capturedSlotId },
            data: {
              currentViewCount: billableViews,
              lastViewCheckAt: new Date(),
            },
          });
          return { status: 'NO_CHANGE' as const, reason: 'no_new_tiers' as const };
        }

        // 3d. createMany with skipDuplicates — the @@unique([slotId, tier])
        // constraint is the real guard; skipDuplicates is the application-layer
        // companion that lets retries succeed without throwing.
        await tx.payoutEvent.createMany({
          data: newTiers.map((t) => ({
            slotId: capturedSlotId,
            tier: t.tier,
            amount: t.amount,
            currency: capturedCurrency,
            billableViews: billableViews,
            billableMetric: billableMetric,
            thresholdViews: t.thresholdViews,
            settlementJson: settlementSnapshot as object,
            // disbursementStatus defaults to PENDING (D5)
          })),
          skipDuplicates: true,
        });

        // 3e. Recompute paidToDate from ledger (D10 — never increment, always sum)
        const allEvents = await tx.payoutEvent.findMany({
          where: { slotId: capturedSlotId },
          select: { amount: true, tier: true },
        });

        const paidMinor = allEvents.reduce(
          (sum, e) => sum + toMinorUnits(e.amount),
          0n,
        );
        const paidToDate = fromMinorUnits(paidMinor);

        // Invariant: paidToDate must never exceed escrowAmount
        if (paidMinor > toMinorUnits(freshSlot.escrowAmount)) {
          throw new SettlementError(
            `paidToDate (${paidToDate.toString()}) exceeds escrowAmount ` +
            `(${freshSlot.escrowAmount.toString()}) for slot ${capturedSlotId}. ` +
            'Rolling back.',
          );
        }

        const allPaidTiers = new Set(allEvents.map((e) => e.tier));
        const highestTierInLedger = TIER_ORDER.slice().reverse().find((t) => allPaidTiers.has(t)) ?? null;
        const isFull = allPaidTiers.has(MilestoneTier.TIER_100);

        // 3f. Update slot cache fields + optionally COMPLETED
        await tx.campaignCreatorSlot.updateMany({
          where: {
            id: capturedSlotId,
            status: isFull ? SlotStatus.IN_PROGRESS : undefined,
          },
          data: {
            currentTier: highestTierInLedger,
            paidToDate: paidToDate,
            currentViewCount: billableViews,
            lastViewCheckAt: new Date(),
            ...(isFull ? { status: SlotStatus.COMPLETED } : {}),
          },
        });

        console.log('[settlement] slotId=%s outcome=ADVANCED newTiers=%s', capturedSlotId, newTiers.map((t) => t.tier).join(','));

        return {
          status: 'ADVANCED' as const,
          newTiers: newTiers.map((t) => t.tier),
          paidToDate,
        };
      },
      {
        isolationLevel: 'Serializable',
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  });
}
