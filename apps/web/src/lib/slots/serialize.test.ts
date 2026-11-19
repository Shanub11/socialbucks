// apps/web/src/lib/slots/serialize.test.ts
//
// Pure unit tests for the creator slot serializer: the response shape is a
// security boundary, so the exact key set is asserted (no creatorId, no userId,
// no email, no clerkId, no organizationId).

import { Prisma, SlotStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';

import { type CreatorSlotRow, serializeCreatorSlot } from './serialize';

const INVITED_AT = new Date('2026-01-01T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-01-08T00:00:00.000Z');

function makeRow(overrides: Partial<CreatorSlotRow> = {}): CreatorSlotRow {
  return {
    id: 'slot_1',
    status: SlotStatus.INVITED,
    escrowAmount: new Prisma.Decimal('40'),
    viewTarget: 100_000,
    metric: 'engagedViews',
    invitedAt: INVITED_AT,
    inviteExpiresAt: EXPIRES_AT,
    acceptedAt: null,
    declinedAt: null,
    campaign: {
      id: 'campaign_1',
      title: 'Spring Campaign',
      description: 'Our big spring push',
      submissionDeadline: new Date('2026-03-01T00:00:00.000Z'),
      organization: { name: 'Acme Inc' },
    },
    ...overrides,
  };
}

describe('serializeCreatorSlot', () => {
  it('renders escrow as a 2dp string', () => {
    const body = serializeCreatorSlot(makeRow());

    expect(body.escrowAmount).toBe('40.00');
    expect(typeof body.escrowAmount).toBe('string');
  });

  it('renders timestamps as ISO strings', () => {
    const body = serializeCreatorSlot(makeRow());

    expect(body.invitedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(body.inviteExpiresAt).toBe('2026-01-08T00:00:00.000Z');
    expect(body.acceptedAt).toBeNull();
    expect(body.declinedAt).toBeNull();
  });

  it('keeps null timestamps null', () => {
    const body = serializeCreatorSlot(
      makeRow({ inviteExpiresAt: null, acceptedAt: null, declinedAt: null }),
    );

    expect(body.inviteExpiresAt).toBeNull();
    expect(body.acceptedAt).toBeNull();
    expect(body.declinedAt).toBeNull();
  });

  it('keeps a null campaign submissionDeadline null', () => {
    const body = serializeCreatorSlot(
      makeRow({ campaign: { ...makeRow().campaign, submissionDeadline: null } }),
    );

    expect(body.campaign.submissionDeadline).toBeNull();
  });

  it('returns exactly the serializer keys and nothing identity-identifying', () => {
    const body = serializeCreatorSlot(makeRow());

    expect(Object.keys(body).sort()).toEqual(
      [
        'acceptedAt',
        'campaign',
        'declinedAt',
        'escrowAmount',
        'id',
        'inviteExpiresAt',
        'invitedAt',
        'metric',
        'organization',
        'status',
        'viewTarget',
      ].sort(),
    );

    expect(Object.keys(body.campaign).sort()).toEqual(
      ['description', 'id', 'submissionDeadline', 'title'].sort(),
    );

    expect(Object.keys(body.organization).sort()).toEqual(['name']);

    // `organization` is top-level, never nested inside `campaign`.
    expect(body.campaign).not.toHaveProperty('organization');

    expect(body).not.toHaveProperty('creatorId');
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('clerkId');
    expect(body).not.toHaveProperty('organizationId');
    expect(body.campaign).not.toHaveProperty('organizationId');
    expect(body).not.toHaveProperty('organizationId');
  });
});