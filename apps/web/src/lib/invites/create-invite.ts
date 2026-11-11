// apps/web/src/lib/invites/create-invite.ts
//
// The transactional core behind POST .../campaigns/[campaignId]/invites.
//
// Why the FOR UPDATE lock: two concurrent invites on the same campaign would
// otherwise both read the same committed escrow total and both pass the budget
// check, overspending the campaign (ADR-0003 invariant 2: committed escrow never
// exceeds the total budget). Locking the campaign row first serializes every
// invite for that campaign, so the aggregate is computed against a stable set of
// slots. The aggregate is the FIRST thing read after the lock, and nothing in
// this transaction inserts a slot before it.
//
// All amounts are compared in bigint minor units (invariant 8); Decimal is only
// the storage type. `committedMinor + escrowMinor` is BigInt addition — the only
// arithmetic performed on money here.
//
// Ordering is a security requirement: the budget check runs BEFORE any
// eligibility lookup, so an over-budget invite reports BUDGET_EXCEEDED no matter
// which address was submitted. Without that, the budget error would itself be an
// oracle for whether an address is an eligible creator.
//
// Not mitigated here: the eligibility failures differ in the queries they run
// and therefore in latency. Closing that side channel needs padding or a
// constant-work path, which this stage does not attempt.

import {
  CampaignStatus,
  Prisma,
  SlotStatus,
  SocialPlatform,
  prisma,
} from '@repo/database';

import { fromMinorUnits, toMinorUnits } from '@/lib/settlement/money';

import {
  FREED_ESCROW_STATUSES,
  INVITE_METRIC,
  INVITE_TTL_DAYS,
  MAX_SLOTS_PER_CAMPAIGN,
} from './constants';
import { INVITE_SELECT, type InviteRow } from './serialize';

const MS_PER_DAY = 86_400_000;

export type CreateInviteInput = {
  organizationId: string;
  campaignId: string;
  /** Already trimmed and lowercased by InviteEmailSchema. */
  creatorEmail: string;
  escrowAmount: Prisma.Decimal;
  viewTarget: number;
  /** Injectable clock for tests; defaults to the current time. */
  now?: Date;
};

export type CreateInviteOutcome =
  | { kind: 'campaign_not_found' }
  | { kind: 'campaign_not_active' }
  | { kind: 'deadline_passed' }
  | { kind: 'slot_limit' }
  /** `remaining` is a 2dp string and is never negative. */
  | { kind: 'budget_exceeded'; remaining: string }
  | { kind: 'not_eligible' }
  | { kind: 'created'; invite: InviteRow };

export async function createInvite(
  input: CreateInviteInput,
): Promise<CreateInviteOutcome> {
  const { organizationId, campaignId, creatorEmail, escrowAmount, viewTarget } =
    input;
  const now = input.now ?? new Date();

  try {
    return await prisma.$transaction(
      async (tx): Promise<CreateInviteOutcome> => {
        // a. Lock the campaign row. This is what makes the budget invariant
        //    race-safe: concurrent invites for this campaign queue here.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Campaign"
          WHERE "id" = ${campaignId}
            AND "organizationId" = ${organizationId}
            AND "deletedAt" IS NULL
          FOR UPDATE
        `;
        if (locked.length === 0) return { kind: 'campaign_not_found' };

        // b. Re-read inside the lock: the row locked above is the row judged.
        const campaign = await tx.campaign.findFirst({
          where: { id: campaignId, organizationId, deletedAt: null },
          select: {
            status: true,
            totalBudget: true,
            submissionDeadline: true,
          },
        });
        if (campaign === null) return { kind: 'campaign_not_found' };

        // c. Only an ACTIVE campaign with a live deadline accepts invites.
        if (campaign.status !== CampaignStatus.ACTIVE) {
          return { kind: 'campaign_not_active' };
        }
        if (
          campaign.submissionDeadline === null ||
          campaign.submissionDeadline.getTime() <= now.getTime()
        ) {
          return { kind: 'deadline_passed' };
        }

        // d. Slot cap, before any eligibility information is produced.
        const slotCount = await tx.campaignCreatorSlot.count({
          where: { campaignId },
        });
        if (slotCount >= MAX_SLOTS_PER_CAMPAIGN) {
          return { kind: 'slot_limit' };
        }

        // e. Budget check, still before eligibility. Soft-deleted slots are
        //    deliberately NOT excluded: escrow may already have been committed.
        const agg = await tx.campaignCreatorSlot.aggregate({
          _sum: { escrowAmount: true },
          where: {
            campaignId,
            status: { notIn: [...FREED_ESCROW_STATUSES] },
          },
        });
        const committedMinor =
          agg._sum.escrowAmount === null
            ? 0n
            : toMinorUnits(agg._sum.escrowAmount);
        const totalMinor = toMinorUnits(campaign.totalBudget);
        const escrowMinor = toMinorUnits(escrowAmount);

        if (committedMinor + escrowMinor > totalMinor) {
          const remainingMinor =
            totalMinor > committedMinor ? totalMinor - committedMinor : 0n;
          return {
            kind: 'budget_exceeded',
            remaining: fromMinorUnits(remainingMinor).toFixed(2),
          };
        }

        // f. Eligibility. Every failure below is the same `not_eligible` so the
        //    caller learns nothing about accounts, creators or connections.
        const users = await tx.user.findMany({
          where: {
            email: { equals: creatorEmail, mode: 'insensitive' },
            deletedAt: null,
          },
          select: {
            id: true,
            creator: {
              select: {
                id: true,
                deletedAt: true,
                socialAccounts: {
                  where: {
                    platform: SocialPlatform.YOUTUBE,
                    revokedAt: null,
                  },
                  select: { id: true },
                },
              },
            },
          },
          take: 2,
        });

        // Zero matches, or more than one: an ambiguous address is not invitable.
        const user = users.at(0);
        if (users.length !== 1 || user === undefined) {
          return { kind: 'not_eligible' };
        }

        const creator = user.creator;
        if (creator === null || creator.deletedAt !== null) {
          return { kind: 'not_eligible' };
        }
        if (creator.socialAccounts.length === 0) {
          return { kind: 'not_eligible' };
        }

        const membership = await tx.organizationMember.findFirst({
          where: { organizationId, userId: user.id },
          select: { id: true },
        });
        if (membership !== null) return { kind: 'not_eligible' };

        // A creator gets at most one slot per campaign, in any status (the DB
        // unique constraint is the backstop; this keeps the response identical).
        const existing = await tx.campaignCreatorSlot.findFirst({
          where: { campaignId, creatorId: creator.id },
          select: { id: true },
        });
        if (existing !== null) return { kind: 'not_eligible' };

        // g. Create the INVITED slot. platform / socialAccountId / contentId
        //    stay null: they are set at submission time.
        const invite = await tx.campaignCreatorSlot.create({
          data: {
            campaignId,
            creatorId: creator.id,
            status: SlotStatus.INVITED,
            escrowAmount,
            viewTarget,
            metric: INVITE_METRIC,
            invitedAt: now,
            inviteExpiresAt: new Date(
              now.getTime() + INVITE_TTL_DAYS * MS_PER_DAY,
            ),
          },
          select: INVITE_SELECT,
        });

        return { kind: 'created', invite };
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    // The (campaignId, creatorId) unique constraint is the backstop if a racing
    // insert beats the existence check. It is still just "not eligible".
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return { kind: 'not_eligible' };
    }
    throw error;
  }
}
