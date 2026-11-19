// apps/web/src/lib/orgs/constants.ts
//
// Limits for the organization API. Kept in one place so the zod schemas and
// the route handlers cannot drift apart.

/** Maximum stored length of an organization name, after trim + NFC. */
export const MAX_ORG_NAME_LENGTH = 100;

/**
 * Soft abuse guard on how many organizations one user may own.
 * Enforced per request in a transaction; see the comment in the create route.
 */
export const MAX_OWNED_ORGS_PER_USER = 10;

/** Page size used when the caller does not pass ?limit. */
export const DEFAULT_PAGE_SIZE = 20;

/** Hard upper bound accepted for ?limit. */
export const MAX_PAGE_SIZE = 50;
