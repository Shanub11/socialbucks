// apps/web/src/lib/orgs/schemas.ts
//
// Zod schemas for the organization API.
//
// Every object schema is strict: an unknown key (role, id, clerkOrgId,
// deletedAt, organizationId, ...) is a 400 instead of a silently dropped
// field, so there is no mass-assignment surface on create.

import { z } from 'zod';

import { MAX_ORG_NAME_LENGTH, MAX_PAGE_SIZE } from './constants';

/**
 * Characters an organization name may not contain:
 * - `\p{Cc}`: control characters (including newlines and NUL)
 * - U+202A..U+202E / U+2066..U+2069: bidi embedding, override and isolate
 *   controls. These can make a name render differently from its bytes, which
 *   is a spoofing vector in member lists, payout recipients and audit logs.
 */
export const ORG_NAME_PATTERN = /^[^\p{Cc}\u202A-\u202E\u2066-\u2069]+$/u;

/**
 * Normalizes first (NFC + trim), then validates the normalized value: a name
 * of only whitespace is rejected, and the stored name is exactly the value
 * that passed the length and character checks.
 */
export const OrgNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, 'Name is required')
      .max(
        MAX_ORG_NAME_LENGTH,
        `Name must be at most ${MAX_ORG_NAME_LENGTH} characters`,
      )
      .regex(ORG_NAME_PATTERN, 'Name contains invalid characters'),
  );

export const CreateOrgBodySchema = z.strictObject({ name: OrgNameSchema });

/** Ids are cuid() in practice; this is the shape accepted on the wire. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const OrgIdParamSchema = z.string().regex(ID_PATTERN);

export const ListOrgsQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,2}$/, 'limit must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_PAGE_SIZE))
    .optional(),
  cursor: z.string().regex(ID_PATTERN, 'Invalid cursor').optional(),
});

export type CreateOrgBody = z.infer<typeof CreateOrgBodySchema>;
export type ListOrgsQuery = z.infer<typeof ListOrgsQuerySchema>;
export type OrgIdParam = z.infer<typeof OrgIdParamSchema>;
