// apps/web/src/lib/campaigns/serialize.ts
//
// The single place a campaign row becomes an API response body.
//
// Every campaign query selects CAMPAIGN_SELECT, so responses are built from a
// known subset and a raw Prisma row is never returned. `deletedAt` is not in
// the select and can therefore never leak. Money leaves as a 2-decimal string
// (Decimal.toFixed), never as a JSON number and never as a serialized Decimal
// object.

import { Prisma } from '@repo/database';

export const CAMPAIGN_SELECT = {
  id: true,
  organizationId: true,
  title: true,
  description: true,
  status: true,
  totalBudget: true,
  currency: true,
  submissionDeadline: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CampaignSelect;

export type CampaignRow = Prisma.CampaignGetPayload<{
  select: typeof CAMPAIGN_SELECT;
}>;

export type SerializedCampaign = {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  status: CampaignRow['status'];
  totalBudget: string;
  currency: string;
  submissionDeadline: string | null;
  createdAt: string;
  updatedAt: string;
};

export function serializeCampaign(row: CampaignRow): SerializedCampaign {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    description: row.description,
    status: row.status,
    totalBudget: row.totalBudget.toFixed(2),
    currency: row.currency,
    submissionDeadline:
      row.submissionDeadline === null
        ? null
        : row.submissionDeadline.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
