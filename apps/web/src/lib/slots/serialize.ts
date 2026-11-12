import { Prisma } from '@repo/database';

export const CREATOR_SLOT_SELECT = {
  id: true, status: true, escrowAmount: true, viewTarget: true, metric: true,
  invitedAt: true, inviteExpiresAt: true, acceptedAt: true, declinedAt: true,
  campaign: { select: { id: true, title: true, description: true, submissionDeadline: true,
                        organization: { select: { name: true } } } },
} as const satisfies Prisma.CampaignCreatorSlotSelect;
export type CreatorSlotRow = Prisma.CampaignCreatorSlotGetPayload<{ select: typeof CREATOR_SLOT_SELECT }>;

export function serializeCreatorSlot(row: CreatorSlotRow) {
  return {
    id: row.id,
    status: row.status,
    escrowAmount: row.escrowAmount.toFixed(2),
    viewTarget: row.viewTarget,
    metric: row.metric,
    invitedAt: row.invitedAt.toISOString(),
    inviteExpiresAt: row.inviteExpiresAt === null ? null : row.inviteExpiresAt.toISOString(),
    acceptedAt: row.acceptedAt === null ? null : row.acceptedAt.toISOString(),
    declinedAt: row.declinedAt === null ? null : row.declinedAt.toISOString(),
    campaign: {
      id: row.campaign.id,
      title: row.campaign.title,
      description: row.campaign.description,
      submissionDeadline: row.campaign.submissionDeadline === null ? null : row.campaign.submissionDeadline.toISOString(),
    },
    organization: { name: row.campaign.organization.name },
  };
}