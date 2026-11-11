// apps/web/src/lib/invites/serialize.test.ts
//
// Pure unit tests for the invite serializer: the response shape is a security
// boundary, so the exact key set is asserted (no creatorId, no socialAccountId,
// no email).

import { Prisma, SlotStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';

import { type InviteRow, serializeInvite } from './serialize';

const INVITED_AT = new Date('2026-01-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-01-08T00:00:00.000Z');

function makeRow(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: 'slot_1',
    campaignId: 'campaign_1',
    status: SlotStatus.INVITED,
    escrowAmount: new Prisma.Decimal('40'),
    viewTarget: 100_000,
    metric: 'engagedViews',
    invitedAt: INVITED_AT,
    inviteExpiresAt: EXPIRES_AT,
    ...overrides,
  };
}

describe('serializeInvite', () => {
  it('renders a one-decimal escrow as a 2dp string', () => {
    const body = serializeInvite(makeRow());

    expect(body.escrowAmount).toBe('40.00');
    expect(typeof body.escrowAmount).toBe('string');
  });

  it('renders timestamps as ISO strings', () => {
    const body = serializeInvite(makeRow());

    expect(body.invitedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(body.inviteExpiresAt).toBe('2026-01-08T00:00:00.000Z');
  });

  it('keeps a null inviteExpiresAt null', () => {
    const body = serializeInvite(makeRow({ inviteExpiresAt: null }));

    expect(body.inviteExpiresAt).toBeNull();
  });

  it('returns exactly the invite keys and nothing invitee-identifying', () => {
    const body = serializeInvite(makeRow());

    expect(Object.keys(body).sort()).toEqual(
      [
        'campaignId',
        'escrowAmount',
        'id',
        'invitedAt',
        'inviteExpiresAt',
        'metric',
        'status',
        'viewTarget',
      ].sort(),
    );
    expect(body).not.toHaveProperty('creatorId');
    expect(body).not.toHaveProperty('socialAccountId');
    expect(body).not.toHaveProperty('email');
  });
});
