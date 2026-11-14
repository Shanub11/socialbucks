-- ============================================================
-- Migration: slot_status_closed
-- Date:      2026-11-14
-- ADR:       0004 — Dispute, closure and baseline finality (D2)
--
-- This migration contains ONE statement and nothing else.
--
-- Postgres cannot reference a newly added enum value in the same transaction
-- that adds it (ALTER TYPE ... ADD VALUE is only usable after commit), and
-- Prisma runs each migration in a transaction. So the value is added here and
-- committed on its own; every statement that needs 'CLOSED' lives in the next
-- migration, 20261114100100_slot_closure_and_dispute.
--
-- CLOSED: the settlement window ended with unreleased escrow
-- (escrowAmount - paidToDate > 0). It is NOT a freed-escrow status: the slot
-- keeps counting its full escrowAmount in the campaign committed total until
-- return handling exists.
-- ============================================================

ALTER TYPE "SlotStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
