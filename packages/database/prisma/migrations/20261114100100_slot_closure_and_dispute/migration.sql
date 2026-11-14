-- ============================================================
-- Migration: slot_closure_and_dispute
-- Date:      2026-11-14
-- ADR:       0004 — Dispute, closure and baseline finality (D2, D3, D4)
--
-- Execution order:
--   1. Slot columns: closure and dispute record
--   2. Slot dispute-raiser foreign key
--   3. Slot CHECK constraints (closure and dispute shape)
--   4. Slot status transition guard trigger
--
-- Requires 20261114100000_slot_status_closed to have committed first: this
-- migration references the 'CLOSED' enum value and will fail otherwise.
--
-- This migration FAILS if an existing row already has status DISPUTED without
-- the new dispute fields (slot_disputed_requires_record is validated against
-- existing rows when it is added). No such rows exist: no dispute transition
-- shipped before this migration.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Slot columns: closure and dispute record
-- ------------------------------------------------------------
-- Only the latest dispute is kept on the row; earlier ones live in the logs
-- until a dispute-history table is justified (ADR-0004).
ALTER TABLE "CampaignCreatorSlot"
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "disputedAt" TIMESTAMP(3),
  ADD COLUMN "disputeReason" TEXT,
  ADD COLUMN "disputeRaisedByUserId" TEXT,
  ADD COLUMN "disputeResolvedAt" TIMESTAMP(3);

-- ------------------------------------------------------------
-- 2. Slot dispute-raiser foreign key
-- ------------------------------------------------------------
-- A dispute must always name a real user; deleting that user is refused so the
-- audit trail cannot be orphaned.
ALTER TABLE "CampaignCreatorSlot"
  ADD CONSTRAINT "CampaignCreatorSlot_disputeRaisedByUserId_fkey"
  FOREIGN KEY ("disputeRaisedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- 3. Slot CHECK constraints
-- ------------------------------------------------------------
ALTER TABLE "CampaignCreatorSlot"
  ADD CONSTRAINT "slot_closed_requires_closed_at" CHECK (
    "status" <> 'CLOSED' OR "closedAt" IS NOT NULL
  ),
  ADD CONSTRAINT "slot_disputed_requires_record" CHECK (
    "status" <> 'DISPUTED' OR (
      "disputedAt" IS NOT NULL
      AND "disputeReason" IS NOT NULL
      AND "disputeRaisedByUserId" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "slot_dispute_reason_len" CHECK (
    "disputeReason" IS NULL OR char_length("disputeReason") BETWEEN 1 AND 1000
  ),
  ADD CONSTRAINT "slot_dispute_resolved_order" CHECK (
    "disputeResolvedAt" IS NULL OR (
      "disputedAt" IS NOT NULL AND "disputeResolvedAt" >= "disputedAt"
    )
  );

-- ------------------------------------------------------------
-- 4. Slot status transition guard (ADR-0004 D3)
-- ------------------------------------------------------------
-- A same-status write is not a transition (cache updates, timestamps,
-- disbursement bookkeeping) and is always allowed.
--
-- CANCELLED frees the slot's escrow in the invite budget check, so allowing it
-- after a baseline was paid would let a campaign overspend its budget
-- (ADR-0003 invariant 2). DISPUTED can only be entered from IN_PROGRESS, and
-- CLOSED only from IN_PROGRESS or DISPUTED: a dispute never resolves to
-- CANCELLED (ADR-0004 D3).
CREATE OR REPLACE FUNCTION "slot_status_transition_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  IF NEW."status" = 'CANCELLED' AND (
       OLD."status" NOT IN ('INVITED', 'ACCEPTED')
    OR OLD."approvedAt" IS NOT NULL
    OR OLD."paidToDate" > 0
  ) THEN
    RAISE EXCEPTION 'A slot can only be cancelled from INVITED or ACCEPTED with nothing paid'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'DISPUTED' AND OLD."status" <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'A dispute can only be raised on an IN_PROGRESS slot'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'CLOSED' AND OLD."status" NOT IN ('IN_PROGRESS', 'DISPUTED') THEN
    RAISE EXCEPTION 'A slot can only be closed from IN_PROGRESS or DISPUTED'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "slot_status_transition_guard_trg"
  BEFORE UPDATE ON "CampaignCreatorSlot"
  FOR EACH ROW EXECUTE FUNCTION "slot_status_transition_guard"();
