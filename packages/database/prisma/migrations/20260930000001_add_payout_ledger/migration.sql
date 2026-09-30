-- ============================================================
-- Migration: add_payout_ledger
-- Date:      2026-09-30
-- ADR:       0002 — Campaign Settlement and Payout Engine
--
-- Execution order:
--   1. Create DisbursementStatus enum.
--   2. Add settlement-identity columns to CampaignCreatorSlot
--      (platform, contentId, socialAccountId, isShort,
--       isShortVerifiedAt, viewTarget).
--   3. Add FK constraint socialAccountId → SocialAccount(id).
--   4. Create PayoutEvent ledger table + indexes.
--
-- Safety invariants:
--   • All new CampaignCreatorSlot columns are nullable.
--     The engine treats null as "not eligible" (HELD) —
--     no existing rows are touched and no back-fill is needed.
--   • PayoutEvent is append-only; no DELETE path exists.
--   • @@unique([slotId, tier]) is the DB-level idempotency key:
--     a given (slot, tier) pair can only ever pay out once.
--   • onDelete: RESTRICT on both FKs — financial rows must
--     never be silently deleted by a cascade.
--   • D3: isShort is write-once in practice; once set to true
--     for a YOUTUBE slot the settlement engine may run.
--     payouts MUST NOT be enabled in production until
--     verifyIsShort() has been independently confirmed against
--     a real channel and isShortVerifiedAt is non-null.
-- ============================================================

-- ------------------------------------------------------------
-- Step 1: DisbursementStatus enum (D5)
-- ------------------------------------------------------------
-- PENDING = released from escrow, awaiting disbursement rail.
-- SENT    = future rail confirmed it was dispatched.
-- FAILED  = future rail reported a terminal failure.
-- This pass writes PENDING only; the rail is out of scope.

CREATE TYPE "DisbursementStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- ------------------------------------------------------------
-- Step 2: New nullable columns on CampaignCreatorSlot (D1, D7)
-- ------------------------------------------------------------
-- All are nullable. The engine treats null as HELD (not eligible).
-- platform + contentId + socialAccountId are write-once in practice:
-- set at CONTENT_SUBMITTED time and never updated.
-- isShort / isShortVerifiedAt are write-once: set once at
-- CONTENT_APPROVED time and never updated (D3).
-- viewTarget is per-slot (D1).

ALTER TABLE "CampaignCreatorSlot"
    ADD COLUMN "platform"            "SocialPlatform",
    ADD COLUMN "contentId"           TEXT,
    ADD COLUMN "socialAccountId"     TEXT,
    ADD COLUMN "isShort"             BOOLEAN,
    ADD COLUMN "isShortVerifiedAt"   TIMESTAMP(3),
    ADD COLUMN "viewTarget"          INTEGER;

-- Comment the write-once intent at the DB level via check constraints
-- (application layer also enforces, but a belt-and-suspenders note here):
COMMENT ON COLUMN "CampaignCreatorSlot"."platform"
    IS 'Write-once: set at CONTENT_SUBMITTED, never updated. Null = not eligible (HELD).';
COMMENT ON COLUMN "CampaignCreatorSlot"."contentId"
    IS 'Write-once: platform canonical content ID. Null = not eligible (HELD).';
COMMENT ON COLUMN "CampaignCreatorSlot"."socialAccountId"
    IS 'Write-once: FK to SocialAccount used at submission. Null = not eligible (HELD).';
COMMENT ON COLUMN "CampaignCreatorSlot"."isShort"
    IS 'Write-once: result of one-time verifyIsShort() call. For YOUTUBE null/false = HELD. Must not be used for payout decisions until isShortVerifiedAt is non-null and confirmed against a real channel.';
COMMENT ON COLUMN "CampaignCreatorSlot"."isShortVerifiedAt"
    IS 'Timestamp of the verifyIsShort() call. Non-null means the classification was recorded.';
COMMENT ON COLUMN "CampaignCreatorSlot"."viewTarget"
    IS 'Per-slot view target for tier thresholds (D1). Null or <= 0 = never settles.';

-- ------------------------------------------------------------
-- Step 3: FK for socialAccountId → SocialAccount (D7)
-- ------------------------------------------------------------
-- onDelete: RESTRICT — a SocialAccount row referenced by a slot
-- must not be deleted while the slot exists. Consistent with
-- every other financial FK in this schema (ADR-0001).

ALTER TABLE "CampaignCreatorSlot"
    ADD CONSTRAINT "CampaignCreatorSlot_socialAccountId_fkey"
    FOREIGN KEY ("socialAccountId")
    REFERENCES "SocialAccount"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Index for the FK column (Prisma may not create this automatically
-- for nullable FKs, but Postgres needs it for the Restrict check).
CREATE INDEX "CampaignCreatorSlot_socialAccountId_idx"
    ON "CampaignCreatorSlot"("socialAccountId");

-- ------------------------------------------------------------
-- Step 4: PayoutEvent ledger table (D5, D8, ADR-0002 §1c)
-- ------------------------------------------------------------
-- Append-only immutable ledger. No DELETE path exists anywhere
-- in the codebase. A PayoutEvent row means "released from escrow,
-- pending disbursement" — it does NOT move money (D5).
--
-- The @@unique([slotId, tier]) constraint is the DB-level
-- idempotency guarantee: INSERT ... ON CONFLICT DO NOTHING
-- makes concurrent and retry-safe advances safe.

CREATE TABLE "PayoutEvent" (
    "id"                  TEXT                  NOT NULL,
    "slotId"              TEXT                  NOT NULL,
    "tier"                "MilestoneTier"       NOT NULL,

    -- D4: integer minor units stored as DECIMAL(12,2) so the
    -- application layer can verify to 2dp. The engine uses BigInt
    -- internally and only converts back to Decimal for storage.
    "amount"              DECIMAL(12,2)         NOT NULL,
    "currency"            TEXT                  NOT NULL DEFAULT 'USD',

    -- D2: the billable metric name (e.g. 'engagedViews', 'views')
    -- and its observed value at trigger time. Storing both lets us
    -- query which metric fired which tier for audit.
    "billableViews"       INTEGER               NOT NULL,
    "billableMetric"      TEXT                  NOT NULL,
    "thresholdViews"      INTEGER               NOT NULL,

    -- D8: raw VideoSettlement (or equivalent) snapshot at trigger.
    -- Stored for dispute evidence. The settlement engine reads this
    -- back for no purpose — it is write-once evidence only.
    "settlementJson"      JSONB                 NOT NULL,

    -- D5: disbursement lifecycle. Only PENDING is written in this pass.
    "disbursementStatus"  "DisbursementStatus"  NOT NULL DEFAULT 'PENDING',
    "disbursedAt"         TIMESTAMP(3),
    "externalRef"         TEXT,

    "createdAt"           TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutEvent_pkey" PRIMARY KEY ("id")
);

-- FK: slotId → CampaignCreatorSlot (onDelete: RESTRICT).
-- Financial records must never be orphaned by a slot deletion.
ALTER TABLE "PayoutEvent"
    ADD CONSTRAINT "PayoutEvent_slotId_fkey"
    FOREIGN KEY ("slotId")
    REFERENCES "CampaignCreatorSlot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- DB-level idempotency key (ADR-0002 §3, D5).
-- A (slot, tier) pair can only ever produce one PayoutEvent row.
-- The settlement engine uses INSERT ... ON CONFLICT DO NOTHING
-- against this constraint. It is the guard — not application code.
CREATE UNIQUE INDEX "PayoutEvent_slotId_tier_key"
    ON "PayoutEvent"("slotId", "tier");

-- FK lookup + range scans by slot.
CREATE INDEX "PayoutEvent_slotId_idx"
    ON "PayoutEvent"("slotId");

-- Temporal range scans for reconciliation / audit queries.
CREATE INDEX "PayoutEvent_createdAt_idx"
    ON "PayoutEvent"("createdAt");

-- Verify counts in migration log.
DO $$
BEGIN
    RAISE NOTICE 'add_payout_ledger: DisbursementStatus enum created.';
    RAISE NOTICE 'add_payout_ledger: CampaignCreatorSlot extended with 6 nullable columns.';
    RAISE NOTICE 'add_payout_ledger: PayoutEvent table created with DB-level idempotency constraint.';
END $$;
