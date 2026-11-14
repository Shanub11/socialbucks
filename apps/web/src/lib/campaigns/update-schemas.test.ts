// apps/web/src/lib/campaigns/update-schemas.test.ts
//
// Pure unit tests for the PATCH body schema: no database, no Clerk, no Next.js
// runtime, so these always run (they are NOT gated on RUN_DB_TESTS).

import { describe, expect, it } from 'vitest';

import { UpdateCampaignBodySchema } from './update-schemas';

const MS_PER_DAY = 86_400_000;
const FUTURE_DEADLINE = new Date(Date.now() + 30 * MS_PER_DAY).toISOString();

describe('UpdateCampaignBodySchema', () => {
  it.each([
    { label: 'a title', body: { title: 'Renamed' } },
    { label: 'a description', body: { description: 'Details' } },
    { label: 'a total budget', body: { totalBudget: '250.00' } },
    { label: 'a currency', body: { currency: 'USD' } },
    { label: 'a submission deadline', body: { submissionDeadline: FUTURE_DEADLINE } },
  ])('accepts $label alone', (testCase) => {
    const result = UpdateCampaignBodySchema.safeParse(testCase.body);

    expect(result.success).toBe(true);
  });

  it('accepts every field together', () => {
    const result = UpdateCampaignBodySchema.safeParse({
      title: 'Renamed',
      description: 'Details',
      totalBudget: '250.00',
      currency: 'USD',
      submissionDeadline: FUTURE_DEADLINE,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the body to parse');
    expect(result.data.totalBudget?.toFixed(2)).toBe('250.00');
    expect(result.data.title).toBe('Renamed');
  });

  it('accepts description null to clear it', () => {
    const result = UpdateCampaignBodySchema.safeParse({ description: null });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the body to parse');
    expect(result.data.description).toBeNull();
  });

  it('accepts submissionDeadline null to clear it', () => {
    const result = UpdateCampaignBodySchema.safeParse({
      submissionDeadline: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the body to parse');
    expect(result.data.submissionDeadline).toBeNull();
  });

  it.each(['title', 'totalBudget', 'currency'])(
    'rejects %s null: those fields can be changed but never cleared',
    (field) => {
      const result = UpdateCampaignBodySchema.safeParse({ [field]: null });

      expect(result.success).toBe(false);
    },
  );

  it('rejects a body with no fields at all', () => {
    const result = UpdateCampaignBodySchema.safeParse({});

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected the body to be rejected');
    expect(result.error.issues[0]?.message).toContain(
      'At least one field must be provided',
    );
  });

  it.each([
    'status',
    'organizationId',
    'id',
    'deletedAt',
    'createdAt',
    'paidToDate',
  ])('rejects the extra key %s', (key) => {
    const result = UpdateCampaignBodySchema.safeParse({ [key]: 'value' });

    expect(result.success).toBe(false);
  });

  it.each([
    { label: 'a JSON-number budget', body: { totalBudget: 100 } },
    { label: 'a zero budget', body: { totalBudget: '0' } },
    { label: 'a sub-cent budget', body: { totalBudget: '1.234' } },
    { label: 'an unsupported currency', body: { currency: 'EUR' } },
    {
      label: 'a past deadline',
      body: { submissionDeadline: '2020-01-01T00:00:00Z' },
    },
    { label: 'an empty title', body: { title: '' } },
  ])('rejects $label', (testCase) => {
    const result = UpdateCampaignBodySchema.safeParse(testCase.body);

    expect(result.success).toBe(false);
  });
});
