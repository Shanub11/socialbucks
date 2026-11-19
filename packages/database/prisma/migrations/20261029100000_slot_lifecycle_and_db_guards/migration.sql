-- ============================================================
-- Migration: slot_lifecycle_and_db_guards
-- Date:      2026-10-29
-- ADR:       0003 — Campaign and slot lifecycle, payout terms
--
-- Execution order:
--   1. New slot statuses (do NOT reference them elsewhere in this migration)
--   2. Campaign: add submissionDeadline
--   3. Slot columns: add lifecycle timestamps, metric
--   4. Backfill existing rows
--   5. Sweeper indexes
--   6. Slot CHECK constraints (escrow, paidToDate, viewTarget, metric, rejectionReason)
--   7. PayoutEvent: nullable billable fields + CHECK for baseline rule
--   8. Slot terms guard trigger
--   9. PayoutEvent append-only trigger
-- ============================================================

-- ------------------------------------------------------------
-- 1. New slot statuses (do NOT reference them elsewhere in this migration)
-- ------------------------------------------------------------
-- EXPIRED: worker sets this when an INVITED slot's inviteExpiresAt passes
-- DECLINED: creator explicitly declines the invite
ALTER TYPE "SlotStatus" ADD VALUE IF NOT EXISTS 'DECLINED';
ALTER TYPE "SlotStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- ------------------------------------------------------------
-- 2. Campaign: add submissionDeadline
-- ------------------------------------------------------------
ALTER TABLE "Campaign" ADD COLUMN "submissionDeadline" TIMESTAMP(3);

-- ------------------------------------------------------------
-- 3. Slot columns
-- ------------------------------------------------------------
ALTER TABLE "CampaignCreatorSlot"
  ADD COLUMN "metric" TEXT,
  ADD COLUMN "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "inviteExpiresAt" TIMESTAMP(3),
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "declinedAt" TIMESTAMP(3),
  ADD COLUMN "reviewDueAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "settlementEndsAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- ------------------------------------------------------------
-- 4. Backfill existing rows
-- ------------------------------------------------------------
-- invitedAt defaults to createdAt at schema level, but for existing rows
-- we explicitly set it from createdAt for clarity
UPDATE "CampaignCreatorSlot" SET "invitedAt" = "createdAt";

-- metric is fixed at invite based on platform
UPDATE "CampaignCreatorSlot"
  SET "metric" = CASE "platform" WHEN 'YOUTUBE' THEN 'engagedViews' WHEN 'INSTAGRAM' THEN 'views' END
  WHERE "platform" IS NOT NULL AND "metric" IS NULL;

-- settlementEndsAt is 30 days after approval for existing slots
UPDATE "CampaignCreatorSlot"
  SET "settlementEndsAt" = "approvedAt" + INTERVAL '30 days'
  WHERE "approvedAt" IS NOT NULL AND "settlementEndsAt" IS NULL;

-- reviewDueAt is 5 days after submission for CONTENT_SUBMITTED slots
UPDATE "CampaignCreatorSlot"
  SET "reviewDueAt" = "submittedAt" + INTERVAL '5 days'
  WHERE "status" = 'CONTENT_SUBMITTED' AND "submittedAt" IS NOT NULL AND "reviewDueAt" IS NULL;

-- ------------------------------------------------------------
-- 5. Sweeper indexes (names match Prisma's convention)
-- ------------------------------------------------------------
CREATE INDEX "CampaignCreatorSlot_status_inviteExpiresAt_idx" ON "CampaignCreatorSlot"("status", "inviteExpiresAt");
CREATE INDEX "CampaignCreatorSlot_status_reviewDueAt_idx" ON "CampaignCreatorSlot"("status", "reviewDueAt");
CREATE INDEX "CampaignCreatorSlot_status_settlementEndsAt_idx" ON "CampaignCreatorSlot"("status", "settlementEndsAt");

-- ------------------------------------------------------------
-- 6. Slot CHECK constraints
-- ------------------------------------------------------------
ALTER TABLE "CampaignCreatorSlot"
  ADD CONSTRAINT "slot_escrow_positive" CHECK ("escrowAmount" > 0),
  ADD CONSTRAINT "slot_paid_within_escrow" CHECK ("paidToDate" >= 0 AND "paidToDate" <= "escrowAmount"),
  ADD CONSTRAINT "slot_view_target_positive" CHECK ("viewTarget" IS NULL OR "viewTarget" > 0),
  ADD CONSTRAINT "slot_metric_known" CHECK ("metric" IS NULL OR "metric" IN ('engagedViews', 'views')),
  ADD CONSTRAINT "slot_rejection_reason_len" CHECK ("rejectionReason" IS NULL OR char_length("rejectionReason") BETWEEN 1 AND 1000);

-- ------------------------------------------------------------
-- 7. PayoutEvent: baseline-at-approval rows carry no analytics
-- ------------------------------------------------------------
ALTER TABLE "PayoutEvent"
  ALTER COLUMN "billableViews" DROP NOT NULL,
  ALTER COLUMN "billableMetric" DROP NOT NULL,
  ALTER COLUMN "thresholdViews" DROP NOT NULL;

ALTER TABLE "PayoutEvent"
  ADD CONSTRAINT "payout_event_amount_nonnegative" CHECK ("amount" >= 0),
  ADD CONSTRAINT "payout_event_trigger_shape" CHECK (
    ("billableViews" IS NOT NULL AND "billableMetric" IS NOT NULL AND "thresholdViews" IS NOT NULL)
    OR ("tier" = 'BASELINE' AND "billableViews" IS NULL AND "billableMetric" IS NULL AND "thresholdViews" IS NULL)
  );

-- ------------------------------------------------------------
-- 8. Slot payout terms are immutable once the slot has left INVITED (ADR-0003 D2)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION "slot_terms_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'INVITED' AND (
       NEW."escrowAmount" IS DISTINCT FROM OLD."escrowAmount"
    OR NEW."viewTarget"   IS DISTINCT FROM OLD."viewTarget"
    OR NEW."metric"       IS DISTINCT FROM OLD."metric"
  ) THEN
    RAISE EXCEPTION 'Slot payout terms are immutable once the slot has left INVITED'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "slot_terms_guard_trg"
  BEFORE UPDATE ON "CampaignCreatorSlot"
  FOR EACH ROW EXECUTE FUNCTION "slot_terms_guard"();

-- ------------------------------------------------------------
-- 9. PayoutEvent is an append-only ledger; only disbursement bookkeeping may change
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION "payout_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PayoutEvent rows are append-only: DELETE is not allowed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id"             IS DISTINCT FROM OLD."id"
  OR NEW."slotId"         IS DISTINCT FROM OLD."slotId"
  OR NEW."tier"           IS DISTINCT FROM OLD."tier"
  OR NEW."amount"         IS DISTINCT FROM OLD."amount"
  OR NEW."currency"       IS DISTINCT FROM OLD."currency"
  OR NEW."billableViews"  IS DISTINCT FROM OLD."billableViews"
  OR NEW."billableMetric" IS DISTINCT FROM OLD."billableMetric"
  OR NEW."thresholdViews" IS DISTINCT FROM OLD."thresholdViews"
  OR NEW."settlementJson" IS DISTINCT FROM OLD."settlementJson"
  OR NEW."createdAt"      IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'PayoutEvent ledger columns are immutable; only disbursementStatus, disbursedAt and externalRef may change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payout_event_append_only_trg"
  BEFORE UPDATE OR DELETE ON "PayoutEvent"
  FOR EACH ROW EXECUTE FUNCTION "payout_event_append_only"();