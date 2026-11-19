// apps/web/src/lib/campaigns/schemas.ts
//
// Zod schemas for the campaign API.
//
// Money never passes through a JS float: a budget enters as a decimal string,
// is validated by regex, and only then becomes a Prisma.Decimal. Every object
// schema is strict, so unknown keys (status, organizationId, id, deletedAt,
// paidToDate, ...) are a 400 instead of a silently dropped field — there is no
// mass-assignment surface on create.

import { CampaignStatus, Prisma } from '@repo/database';
import { z } from 'zod';

import { MAX_PAGE_SIZE } from '@/lib/orgs/constants';

import {
  MAX_CAMPAIGN_DESCRIPTION_LENGTH,
  MAX_CAMPAIGN_TITLE_LENGTH,
  MAX_DEADLINE_DAYS_AHEAD,
  SUPPORTED_CAMPAIGN_CURRENCIES,
} from './constants';

/**
 * Characters a title may not contain:
 * - `\p{Cc}`: control characters (including newlines and NUL)
 * - U+202A..U+202E / U+2066..U+2069: bidi embedding, override and isolate
 *   controls, which can make text render differently from its bytes.
 */
const TITLE_PATTERN = /^[^\p{Cc}\u202A-\u202E\u2066-\u2069]+$/u;

/**
 * A description may contain newlines, carriage returns and tabs, but no other
 * control characters and no bidi overrides.
 */
const DESCRIPTION_PATTERN = /^(?:[^\p{Cc}\u202A-\u202E\u2066-\u2069]|[\n\r\t])*$/u;

/**
 * 0 or no leading zero, up to 10 integer digits, optional 1-2 decimals:
 * fits the DECIMAL(12,2) column exactly, with no exponent or sign form.
 */
const BUDGET_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;

/** Ids are cuid() in practice; this is the shape accepted on the wire. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MS_PER_DAY = 86_400_000;

/** Normalizes first (NFC + trim), then validates the normalized value. */
export const CampaignTitleSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, 'Title is required')
      .max(
        MAX_CAMPAIGN_TITLE_LENGTH,
        `Title must be at most ${MAX_CAMPAIGN_TITLE_LENGTH} characters`,
      )
      .regex(TITLE_PATTERN, 'Title contains invalid characters'),
  );

export const CampaignDescriptionSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, 'Description must not be empty')
      .max(
        MAX_CAMPAIGN_DESCRIPTION_LENGTH,
        `Description must be at most ${MAX_CAMPAIGN_DESCRIPTION_LENGTH} characters`,
      )
      .regex(DESCRIPTION_PATTERN, 'Description contains invalid characters'),
  );

/**
 * Budget: a decimal string, converted to Prisma.Decimal (never a JS number)
 * and required to be strictly positive. `0` and `0.00` match the shape but
 * fail the positivity check.
 */
export const CampaignBudgetSchema = z
  .string()
  .regex(
    BUDGET_PATTERN,
    'Budget must be a decimal string with at most 2 decimal places',
  )
  .transform((value) => new Prisma.Decimal(value))
  .refine((amount) => amount.gt(0), 'Budget must be greater than zero');

export const SubmissionDeadlineSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .refine((deadline) => {
    const time = deadline.getTime();
    const now = Date.now();
    return (
      Number.isFinite(time) &&
      time > now &&
      time <= now + MAX_DEADLINE_DAYS_AHEAD * MS_PER_DAY
    );
  }, `Deadline must be a valid future date within ${MAX_DEADLINE_DAYS_AHEAD} days`);

export const CreateCampaignBodySchema = z.strictObject({
  title: CampaignTitleSchema,
  description: CampaignDescriptionSchema.optional(),
  totalBudget: CampaignBudgetSchema,
  currency: z.enum(SUPPORTED_CAMPAIGN_CURRENCIES).default('USD'),
  submissionDeadline: SubmissionDeadlineSchema.optional(),
});

export const CampaignIdParamSchema = z.string().regex(ID_PATTERN);

export const ListCampaignsQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,2}$/, 'limit must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_PAGE_SIZE))
    .optional(),
  cursor: z.string().regex(ID_PATTERN, 'Invalid cursor').optional(),
  status: z.enum(CampaignStatus).optional(),
});

export type CreateCampaignBody = z.infer<typeof CreateCampaignBodySchema>;
export type ListCampaignsQuery = z.infer<typeof ListCampaignsQuerySchema>;
