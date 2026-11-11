// apps/web/src/lib/campaigns/update-schemas.ts
//
// Zod schema for PATCHing a DRAFT campaign.
//
// Every object schema is strict, so unknown keys (status, organizationId, id,
// deletedAt, createdAt, paidToDate, ...) are a 400 instead of a silently
// dropped field. `description` and `submissionDeadline` may be null to clear
// them; `title`, `totalBudget` and `currency` can be changed but never cleared.
// At least one field must be provided — an empty PATCH is a client bug, not a
// no-op.

import { z } from 'zod';

import { SUPPORTED_CAMPAIGN_CURRENCIES } from './constants';
import {
  CampaignBudgetSchema,
  CampaignDescriptionSchema,
  CampaignTitleSchema,
  SubmissionDeadlineSchema,
} from './schemas';

export const UpdateCampaignBodySchema = z
  .strictObject({
    title: CampaignTitleSchema.optional(),
    description: CampaignDescriptionSchema.nullable().optional(),
    totalBudget: CampaignBudgetSchema.optional(),
    currency: z.enum(SUPPORTED_CAMPAIGN_CURRENCIES).optional(),
    submissionDeadline: SubmissionDeadlineSchema.nullable().optional(),
  })
  .refine(
    (body) => Object.keys(body).length > 0,
    'At least one field must be provided',
  );

export type UpdateCampaignBody = z.infer<typeof UpdateCampaignBodySchema>;
