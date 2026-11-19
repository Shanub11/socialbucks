// apps/web/src/lib/campaigns/constants.ts
//
// Limits and allowlists for the campaign API. Kept in one place so the zod
// schemas and the route handlers cannot drift apart.

/** Maximum stored length of a campaign title, after trim + NFC. */
export const MAX_CAMPAIGN_TITLE_LENGTH = 120;

/** Maximum stored length of a campaign description, after trim + NFC. */
export const MAX_CAMPAIGN_DESCRIPTION_LENGTH = 2000;

/**
 * Launch allowlist of campaign currencies. Fail closed: anything not listed
 * here is rejected, because settlement arithmetic only supports exactly
 * 2-decimal currencies (see lib/settlement/money.ts).
 *
 * Widening this is a product decision (ADR-0003 OQ-6), not an implementation
 * detail — a new entry also needs a matching 2-decimal currency in the
 * settlement allowlist.
 */
export const SUPPORTED_CAMPAIGN_CURRENCIES = ['USD'] as const;

/** Furthest a submission deadline may be set into the future. */
export const MAX_DEADLINE_DAYS_AHEAD = 365;

/**
 * Soft abuse guard on how many DRAFT campaigns one organization may hold.
 * Enforced per request in a transaction; see the comment in the create route.
 */
export const MAX_DRAFT_CAMPAIGNS_PER_ORG = 50;
