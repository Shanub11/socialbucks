# ADR-0002 — Campaign Settlement and Payout Engine

| Field        | Value                  |
|--------------|------------------------|
| Status       | **Accepted**           |
| Date         | 2026-09-27             |
| Author       | @Shanub11              |
| Supersedes   | —                      |
| Superseded by | —                     |

---

## Context

A `CampaignCreatorSlot` escrows a fixed `escrowAmount` for a creator. Once
content is approved, a background settlement job polls the platform's analytics
API on a schedule, advances through four milestone tiers, and releases a
fraction of escrow into the creator's hands at each crossing. This ADR designs
that entire path — schema, algorithm, concurrency guarantees, anomaly policy,
and dispute handling — for review before any code is written.

### What already exists

- `CampaignCreatorSlot` has `escrowAmount`, `currentTier` (`MilestoneTier?`),
  `paidToDate` (mutable running total), `contentUrl`, `currentViewCount`,
  `lastViewCheckAt`.
- `MilestoneTier` enum: `BASELINE`, `TIER_40`, `TIER_70`, `TIER_100`.
- `SlotStatus` enum includes `IN_PROGRESS`, `COMPLETED`, `DISPUTED`.
- `fetchVideoSettlement` returns a `VideoSettlement` with `views`,
  `engagedViews`, `estimatedMinutesWatched`, `averageViewPercentage`, `likes`,
  `comments`, `shares`, `subscribersGained`, `videosAddedToPlaylists`.
- `verifyIsShort` classifies a YouTube video via the Analytics API's
  `creatorContentType` dimension. **Its query shape is not yet independently
  verified against a real channel** — that gap is documented here explicitly.
- Instagram analytics are not yet implemented.

---

## Proposed Changes

### 1. Schema changes

#### 1a. Platform + content identity on `CampaignCreatorSlot`

The engine cannot decide which analytics function to call without knowing the
platform. Parsing `contentUrl` at settlement time is fragile — URL shapes
change, and Instagram graph IDs are not in the URL at all.

**Proposal:** Add two columns to `CampaignCreatorSlot` at content-submission
time:

```prisma
/// The platform the submitted content lives on.
/// Set at CONTENT_SUBMITTED time, immutable thereafter.
platform       SocialPlatform?

/// The platform's canonical content ID (YouTube video ID, Instagram media ID).
/// Never the full URL — the URL is display-only. This is what the analytics
/// function receives.
contentId      String?

/// Foreign key to the SocialAccount used when this content was submitted.
/// Kept so we can retrieve the correct access token for analytics calls,
/// and so the audit trail records which connected account was active.
socialAccountId String?
socialAccount   SocialAccount? @relation(fields: [socialAccountId], references: [id], onDelete: Restrict)
```

`contentUrl` stays for display; `platform` + `contentId` are what the engine
actually uses. `socialAccountId` pins the token source.

> **Open question OQ-1**: Should `platform` and `contentId` be `NOT NULL`
> once a slot reaches `CONTENT_SUBMITTED`, enforced at the application layer,
> or does the schema allow nullable for backwards-compatibility with any
> existing rows? Recommendation: make them required at submission time via
> application validation, keep nullable in schema for zero-downtime migration.

#### 1b. Shorts classification storage

ADR-0001's own note states the Shorts classification result should be stored
once and never re-queried. There is currently no column for it.

**Proposal:** Add to `CampaignCreatorSlot`:

```prisma
/// Result of the one-time verifyIsShort() call made at CONTENT_APPROVED time.
/// null = not yet determined (job has not run) or platform does not apply.
/// This column is write-once: once set it is never updated.
isShort        Boolean?
isShortVerifiedAt DateTime?
```

> **Open question OQ-2**: `verifyIsShort`'s Analytics API query shape is
> currently unverified against a real channel. Before the settlement engine
> reads this column and makes payout decisions based on it, someone must run
> the verify-youtube-shorts script against a real Short and a real long-form
> video and record the result in this ADR. Until then this column exists but
> its write is blocked in code by a feature flag or `TODO: requires API
> verification`. Do not treat it as reliable.

#### 1c. Payout ledger table (`PayoutEvent`)

`paidToDate` as a single mutable running total provides no audit trail. A
dispute filed months later cannot reconstruct which tier paid when, at what
amount, triggered by what view count. This does not meet the project's own
standard (`onDelete: Restrict` + audit trail for anything financial, as
established in ADR-0001).

**Proposal:** New table:

```prisma
model PayoutEvent {
  id        String   @id @default(cuid())
  slotId    String
  tier      MilestoneTier
  amount    Decimal  @db.Decimal(12, 2)
  currency  String   @default("USD")

  /// View count that triggered this payout, as read from the analytics API.
  viewsAtTrigger   Int
  /// Settlement snapshot at trigger time — stored for dispute evidence.
  settlementJson   Json

  /// The job run that produced this event. Useful for replaying or auditing.
  jobRunId  String?

  createdAt DateTime @default(now())

  slot CampaignCreatorSlot @relation(fields: [slotId], references: [id], onDelete: Restrict)

  /// Enforces idempotency: a given (slot, tier) pair can only pay out once.
  /// The settlement job uses this as the conflict target for an upsert-or-skip.
  @@unique([slotId, tier])

  @@index([slotId])
  @@index([createdAt])
}
```

`paidToDate` on `CampaignCreatorSlot` becomes **a read-only derived view** —
updated by the settlement job as a convenience cache, but the ledger is the
source of truth.

> **Open question OQ-3**: Should `settlementJson` store the raw
> `VideoSettlement` snapshot, or a structured sub-schema? Raw JSON is simpler
> now; a structured schema is queryable later. Recommendation: raw JSON in v1,
> add a typed schema if dispute queries become a pattern.

---

### 2. Tier-progression algorithm

#### Tier thresholds and amounts

The four tiers are thresholds crossed, not states visited. The total release
across all four tiers equals `escrowAmount`.

| Tier        | View threshold (% of campaign target) | Release fraction |
|-------------|---------------------------------------|-----------------|
| `BASELINE`  | 20 %                                  | 20 % of escrow  |
| `TIER_40`   | 40 %                                  | 20 % of escrow  |
| `TIER_70`   | 70 %                                  | 30 % of escrow  |
| `TIER_100`  | 100 %                                 | 30 % of escrow  |

> **Open question OQ-4**: The view threshold is expressed as "% of campaign
> target" — but `Campaign` has no `viewTarget` column. Is the target an
> absolute view count (e.g. 100 000 views) stored somewhere not yet in the
> schema, or a relative metric (e.g. percentage of views relative to a
> benchmark)? This must be resolved before the algorithm can be implemented.
> Recommendation: add `viewTarget Int?` to `Campaign` or to
> `CampaignCreatorSlot` (if it's per-creator).

#### Progression rules

1. **Strictly monotonic forward-only.** `currentTier` never moves backward.
   If YouTube or Instagram revises a view count downward between two scheduled
   checks, no tier is reversed and no payout is clawed back. Once a tier
   threshold is crossed and the corresponding `PayoutEvent` is written, it
   is permanent.

2. **Skipped tiers still pay.** If a check jumps from below-BASELINE directly
   above 70 %, all three crossed tiers (`BASELINE`, `TIER_40`, `TIER_70`) are
   paid in a single job run, in order, in the same database transaction. Each
   produces its own `PayoutEvent` row. The `@@unique([slotId, tier])` on
   `PayoutEvent` ensures idempotency if the transaction is retried.

3. **Algorithm (pseudocode):**

```
function advanceTiers(slot, currentViews):
  newTier = highestCrossedTier(currentViews, slot.viewTarget)
  if newTier == null or newTier <= slot.currentTier:
    return  // nothing to do

  tiersToRelease = tiersAbove(slot.currentTier, up to newTier)
  within a single DB transaction:
    for each tier in tiersToRelease (ascending):
      INSERT INTO PayoutEvent (slotId, tier, amount, ...) ON CONFLICT DO NOTHING
      // ON CONFLICT means: if this row already exists (retry / concurrent run),
      // skip silently. The @@unique constraint makes this safe.
    UPDATE CampaignCreatorSlot
      SET currentTier = newTier,
          paidToDate  = paidToDate + sum(released amounts),
          lastViewCheckAt = now(),
          currentViewCount = currentViews
      WHERE id = slot.id AND currentTier < newTier  // compare-and-swap guard
    if slot reaches TIER_100:
      SET status = COMPLETED
```

> **Open question OQ-5**: What is the precise definition of "views"? For
> YouTube Shorts post-March 2025, YouTube counts any play regardless of
> watch-time threshold. `fetchVideoSettlement` returns both `views` and
> `engagedViews`. Which does the tier algorithm use? Using `views` benefits
> creators but is less meaningful to brands; `engagedViews` is more selective
> but will be lower. Decision needed before implementation.

---

### 3. Idempotency and concurrency

The settlement job will run on a schedule (pg-boss, not yet installed). Two
risks: (a) a job overlaps itself, (b) a job partially succeeds, then retries.

**Recommendation: `@@unique([slotId, tier])` on `PayoutEvent` as the
idempotency key.** The settlement job:

1. Queries the slot for `currentTier` and `currentViewCount`.
2. Calls the analytics API to get fresh view count.
3. Computes which tiers should now be paid.
4. For each tier, does `INSERT ... ON CONFLICT (slotId, tier) DO NOTHING`.
5. Only if the insert succeeded (affected rows = 1) does it update `paidToDate`
   and `currentTier`.
6. All inserts + the slot update happen in a **single serializable transaction**.

This guarantees:

- **No double-payment**: the unique constraint rejects the second insert.
- **Retry safety**: a partial failure before the slot update is safe — on retry
  the inserts hit `ON CONFLICT DO NOTHING`, the update proceeds.
- **Concurrent safety**: two job workers racing on the same slot both issue
  `INSERT ON CONFLICT DO NOTHING`; only one wins, both then try to update
  `currentTier`; the compare-and-swap `WHERE currentTier < newTier` ensures
  the loser's update is a no-op.

> **Open question OQ-6**: pg-boss is not yet installed. Before the settlement
> job is implemented, a decision is needed on: (a) job granularity — one job
> per slot, or one job per campaign, or one batch job across all active slots;
> (b) retry policy — pg-boss has built-in retry-with-backoff, which we should
> use rather than rolling our own; (c) whether the job needs a distributed
> lock at the slot level or whether the DB-level idempotency above is
> sufficient. Recommendation: one pg-boss job per slot, let pg-boss handle
> retries, rely on the unique constraint + serializable transaction for
> concurrency.

---

### 4. Fraud and anomaly handling

`fetchVideoSettlement` already returns `engagedViews`, `views`,
`averageViewPercentage`, and `estimatedMinutesWatched`. The question is
whether v1 gates any payout on suspicious ratios.

**Decision for v1: no automated fraud gate.** Rationale:

- The existing ADR-004 (referenced in the task description) already decided to
  ship simplified milestone tiers first without fraud-checking logic.
- `averageViewPercentage` legitimately exceeds 100 for loopable Shorts.
  Any threshold on that metric would need Shorts-aware branching before it
  is meaningful.
- `engagedViews / views` ratios vary significantly by platform, content type,
  and creator audience. A hard-coded threshold without calibration data risks
  false positives on legitimate content.

**What v1 does instead:**

- Stores the full `settlementJson` snapshot in `PayoutEvent` so anomalies can
  be detected in post-hoc queries.
- Surfaces `engagedViews / views` ratio in the slot's admin view (design TBD).
- A `DISPUTED` status transition is available for manual intervention (see §5).

**Explicitly deferred to v2:** Automated anomaly detection, bot-view detection,
threshold-based holds.

> This is a deliberate, documented non-decision — not an oversight.

---

### 5. Dispute handling

`SlotStatus.DISPUTED` already exists. This ADR proposes the following rules:

1. **What sets DISPUTED:** An admin-only API endpoint (or a brand-side
   "raise dispute" action) transitions a slot from any active status to
   `DISPUTED`. The transition is an explicit write, never automatic.

2. **Dispute freezes further payouts.** The settlement job skips any slot
   where `status = 'DISPUTED'`. The `PayoutEvent` ledger is append-only and
   already written, so past payouts survive; only future releases are frozen.

3. **Resolution paths:**
   - **Resolved in creator's favour**: status returns to `IN_PROGRESS` (or
     `COMPLETED` if tier 100 was already crossed). Settlement job resumes.
   - **Resolved in brand's favour**: status transitions to `CANCELLED`.
     The `escrowAmount` not yet released is returned to the brand. This
     requires a corresponding financial operation (out of scope for this ADR)
     and a final `PayoutEvent` with a negative amount or a separate
     `ClawbackEvent` table (open question).
   - **Partially resolved**: tiers below the disputed point are confirmed; the
     disputed tier is adjusted. Requires manual `PayoutEvent` insertion by an
     admin.

> **Open question OQ-7**: Does the brand have a self-serve "raise dispute" UI
> in v1, or is this always an admin-mediated action? The technical
> implementation is the same either way, but the authorisation check differs.

> **Open question OQ-8**: Clawbacks — if a dispute resolves in the brand's
> favour for tiers already paid, is there a `ClawbackEvent` table, or does the
> resolution flow live entirely outside this system (e.g. manual Stripe
> refund)? Recommendation: out of scope for the settlement engine; record the
> decision in the next ADR covering financial operations.

---

## Verification plan

Before this ADR is accepted and implementation begins:

1. **OQ-2 (verifyIsShort)**: Run `verify-youtube-shorts.ts` (or equivalent)
   against a real Short and a real long-form video from a connected channel.
   Record the actual `creatorContentType` values returned. Update this ADR
   with the result.

2. **OQ-4 (view target)**: Confirm where the per-creator view target is stored
   or will be stored. Update the schema proposal.

3. **OQ-5 (views vs engagedViews)**: Brand-product decision. Record the
   outcome here.

All other open questions can be resolved during implementation without blocking
the design review.

---

## Alternatives rejected

**Single `paidToDate` mutable total (current state):** No audit trail. Disputes
months later cannot reconstruct the sequence of events. Rejected.

**Backward-moving tiers (clawback on view revision):** Creates a payment-then-
clawback cycle that requires refund infrastructure before it can ship, and
antagonises creators for YouTube's own data revisions. Monotonic-forward-only
avoids this entirely. Rejected.

**Fraud-gating in v1:** Would require calibration data we don't have and risks
false positives on legitimate Shorts content. Explicitly deferred, not silently
skipped.

**Per-run idempotency key instead of `@@unique([slotId, tier])`:** A per-run
key prevents duplicate runs, but does not prevent a duplicate tier payment if
the key changes (e.g. job is re-queued under a new ID). Tier-level uniqueness
is the right granularity for financial idempotency. Rejected.

---

## Consequences

**Positive:**
- Full audit trail: every payout is an immutable ledger row with a settlement
  snapshot.
- Idempotency is enforced at the DB level, not the application level.
- Platform ambiguity at settlement time is eliminated.
- Shorts classification is stored once; the Analytics API is not polled on
  every settlement check.
- Dispute handling is explicit and auditable.

**Negative:**
- Three open questions (OQ-2, OQ-4, OQ-5) are blocking — implementation cannot
  start until they are resolved.
- pg-boss is not yet installed; the settlement job is designed but not
  schedulable.
- Adding `socialAccountId` to `CampaignCreatorSlot` requires a migration
  and a one-time backfill for any existing slots.

## Decision Log

Recorded 2026-09-30, implementing the engine in three phases.

- **D1** — View target lives on the slot: `CampaignCreatorSlot.viewTarget Int?` (escrowAmount is per-slot, so the target is too). A slot with a null or <= 0 target never settles.
- **D2** — The billable metric is chosen by ONE per-platform mapping function: YouTube -> engagedViews, Instagram -> views. Flipping a platform's metric must be a one-line change. The ledger stores both the metric name and its value.
- **D3** — `verifyIsShort` is still unverified against real channels, so fail closed: a YOUTUBE slot settles only if `isShort === true`. null or false -> HELD, no writes. Real-channel verification remains a human step; the ADR must say payouts must not be enabled in production until its result is recorded there.
- **D4** — Rounding. Integer minor units only, never JS floats. Cumulative basis points: BASELINE 2000, TIER_40 4000, TIER_70 7000, TIER_100 10000. `cumAmount(tier) = floor(escrowMinor * cumBps / 10000)`, except TIER_100 = escrowMinor exactly. `tierAmount = cumAmount(tier) - cumAmount(previous tier)`. The final tier absorbs the remainder, so the tiers always sum to escrow exactly. Thresholds: `thresholdViews = ceil(viewTarget * cumBps / 10000)`, integer math. A tier is crossed when `billableViews >= thresholdViews`.
- **D5** — Scope: this is the internal ledger + state machine only. A PayoutEvent row means "released from escrow, pending disbursement" — it does NOT move money. No payment rail, no clawbacks. `DisbursementStatus {PENDING, SENT, FAILED}`, `PayoutEvent.disbursementStatus` default PENDING, plus nullable `disbursedAt` and `externalRef` for the future rail. Nothing in this pass writes anything but PENDING.
- **D6** — No pg-boss this pass. `settleSlot()` is an internal service function with no HTTP surface and no scheduler.
- **D7** — New slot columns are nullable in the schema; the engine treats a null platform/contentId/socialAccountId as not eligible (HELD).
- **D8** — `settlementJson` stores the raw VideoSettlement snapshot.
- **D9** — Only the DISPUTED freeze is implemented (settlement skips any slot not IN_PROGRESS). Raising disputes and clawbacks are out of scope.
- **D10** — The ledger is the source of truth. `paidToDate` and `currentTier` are caches recomputed from the ledger inside the transaction, never incremented. Currency comes from `Campaign.currency`; assert a 2-decimal currency and throw otherwise.
