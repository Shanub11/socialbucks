// apps/web/src/lib/invites/serialize.ts
//
// The single place a slot row becomes an invite response body.
//
// The select is deliberately narrow: it never includes creatorId,
// socialAccountId or anything reachable from the invitee's user record, so an
// invite response cannot disclose who the creator is beyond the address the
// caller already typed. Money leaves as a 2-decimal string, never a number.

import { Prisma } from '@repo/database';

export const INVITE_SELECT = {
  id: true,
  campaignId: true,
  status: true,
  escrowAmount: true,
  viewTarget: true,
  metric: true,
  invitedAt: true,
  inviteExpiresAt: true,
} as const satisfies Prisma.CampaignCreatorSlotSelect;

export type InviteRow = Prisma.CampaignCreatorSlotGetPayload<{
  select: typeof INVITE_SELECT;
}>;

export type SerializedInvite = {
  id: string;
  campaignId: string;
  status: InviteRow['status'];
  escrowAmount: string;
  viewTarget: number | null;
  metric: string | null;
  invitedAt: string;
  inviteExpiresAt: string | null;
};

export function serializeInvite(row: InviteRow): SerializedInvite {
  return {
    id: row.id,
    campaignId: row.campaignId,
    status: row.status,
    escrowAmount: row.escrowAmount.toFixed(2),
    viewTarget: row.viewTarget,
    metric: row.metric,
    invitedAt: row.invitedAt.toISOString(),
    inviteExpiresAt:
      row.inviteExpiresAt === null ? null : row.inviteExpiresAt.toISOString(),
  };
}
