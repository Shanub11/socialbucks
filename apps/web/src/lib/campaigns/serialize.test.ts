// apps/web/src/lib/campaigns/serialize.test.ts
//
// Pure unit tests for the campaign serializer: no database, no Clerk, no Next.js
// runtime, so these always run (they are NOT gated on RUN_DB_TESTS).

import { CampaignStatus, Prisma } from '@repo/database';
import { describe, expect, it } from 'vitest';

import { type CampaignRow, serializeCampaign } from './serialize';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const UPDATED_AT = new Date('2026-01-02T03:04:05.000Z');

const SERIALIZED_KEYS = [
  'createdAt',
  'currency',
  'description',
  'id',
  'organizationId',
  'status',
  'submissionDeadline',
  'title',
  'totalBudget',
  'updatedAt',
].sort();

function buildRow(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: 'campaign_1',
    organizationId: 'org_1',
    title: 'Spring Launch',
    description: null,
    status: CampaignStatus.DRAFT,
    totalBudget: new Prisma.Decimal('5'),
    currency: 'USD',
    submissionDeadline: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('serializeCampaign', () => {
  it('formats an integer budget as a 2-decimal string', () => {
    const body = serializeCampaign(buildRow());

    expect(body.totalBudget).toBe('5.00');
  });

  it('formats a one-decimal budget as a 2-decimal string', () => {
    const body = serializeCampaign(
      buildRow({ totalBudget: new Prisma.Decimal('1234.5') }),
    );

    expect(body.totalBudget).toBe('1234.50');
  });

  it('returns the budget as a string, never a number', () => {
    const body = serializeCampaign(buildRow());

    expect(typeof body.totalBudget).toBe('string');
  });

  it('serializes dates as ISO strings', () => {
    const body = serializeCampaign(buildRow());

    expect(body.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(body.updatedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('keeps a null description and a null deadline null', () => {
    const body = serializeCampaign(buildRow());

    expect(body.description).toBeNull();
    expect(body.submissionDeadline).toBeNull();
  });

  it('serializes a populated description and deadline', () => {
    const deadline = new Date('2026-06-01T12:30:00.000Z');
    const body = serializeCampaign(
      buildRow({ description: 'Details', submissionDeadline: deadline }),
    );

    expect(body.description).toBe('Details');
    expect(body.submissionDeadline).toBe(deadline.toISOString());
  });

  it('returns exactly the public keys and never deletedAt', () => {
    const body = serializeCampaign(buildRow());

    expect(Object.keys(body).sort()).toEqual(SERIALIZED_KEYS);
    expect(body).not.toHaveProperty('deletedAt');
  });
});
