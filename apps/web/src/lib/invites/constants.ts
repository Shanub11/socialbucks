// apps/web/src/lib/invites/constants.ts
//
// Single source of truth for invite limits. The zod schemas, the transactional
// core and the tests all read these, so the wire rules and the enforcement
// cannot drift apart.

import { SlotStatus } from '@repo/database';

/**
 * How long an invite stays actionable before the sweeper may expire it
 * (ADR-0003 D4). Stored per slot in `inviteExpiresAt`, never recomputed on read.
 */
export const INVITE_TTL_DAYS = 7;

/**
 * Hard cap on slots (in any status) per campaign. Checked before any
 * eligibility lookup so the response cannot depend on who is being invited.
 */
export const MAX_SLOTS_PER_CAMPAIGN = 100;

/**
 * Minimum escrow a single slot may hold, as a decimal string. Compared in
 * bigint minor units, never as a float.
 */
export const MIN_SLOT_ESCROW = '5.00';

/** Smallest accepted per-slot view target. */
export const MIN_VIEW_TARGET = 100;

/**
 * Largest accepted per-slot view target. Fits Postgres int4 with a wide margin;
 * this is a sanity bound, not a platform limit (ADR-0003 OQ-3). Widening it is
 * a deliberate product decision.
 */
export const MAX_VIEW_TARGET = 100_000_000;

/**
 * The billing metric fixed at invite time (ADR-0003 D3). Set by the server from
 * this constant — a client can never choose the metric.
 */
export const INVITE_METRIC = 'engagedViews' as const;

/**
 * Slot states that no longer commit budget. A DECLINED, EXPIRED or CANCELLED
 * slot has released its escrow, so it is excluded from the committed total.
 * Every other status still counts, including soft-deleted slots: money may
 * already have moved against them.
 */
export const FREED_ESCROW_STATUSES = [
  SlotStatus.DECLINED,
  SlotStatus.EXPIRED,
  SlotStatus.CANCELLED,
] as const;
