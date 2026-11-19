// apps/web/src/lib/campaigns/schemas.test.ts
//
// Pure unit tests for the campaign schemas: no database, no Clerk, no Next.js
// runtime, so these always run (they are NOT gated on RUN_DB_TESTS).

import { Prisma } from '@repo/database';
import { describe, expect, it } from 'vitest';

import {
  CampaignBudgetSchema,
  CampaignDescriptionSchema,
  CampaignTitleSchema,
  CreateCampaignBodySchema,
  ListCampaignsQuerySchema,
  SubmissionDeadlineSchema,
} from './schemas';

const MS_PER_DAY = 86_400_000;

/** A minimal body that passes CreateCampaignBodySchema. */
const BASE_BODY = { title: 'Spring Launch', totalBudget: '100.00' };

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString();
}

describe('CampaignTitleSchema', () => {
  it('trims surrounding whitespace', () => {
    const result = CampaignTitleSchema.safeParse('  Spring Launch  ');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the title to parse');
    expect(result.data).toBe('Spring Launch');
  });

  it('normalizes to NFC', () => {
    const result = CampaignTitleSchema.safeParse('Cafe\u0301');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the title to parse');
    expect(result.data).toBe('Café');
  });

  it('rejects an empty title', () => {
    expect(CampaignTitleSchema.safeParse('').success).toBe(false);
  });

  it('rejects a whitespace-only title', () => {
    expect(CampaignTitleSchema.safeParse('   \t  ').success).toBe(false);
  });

  it('accepts exactly 120 characters', () => {
    expect(CampaignTitleSchema.safeParse('a'.repeat(120)).success).toBe(true);
  });

  it('rejects 121 characters', () => {
    expect(CampaignTitleSchema.safeParse('a'.repeat(121)).success).toBe(false);
  });

  it('rejects control characters', () => {
    expect(CampaignTitleSchema.safeParse('Spring\u0000Launch').success).toBe(
      false,
    );
    expect(CampaignTitleSchema.safeParse('Spring\nLaunch').success).toBe(false);
  });

  it('rejects bidi override and isolate characters', () => {
    expect(CampaignTitleSchema.safeParse('Spring\u202ELaunch').success).toBe(
      false,
    );
    expect(CampaignTitleSchema.safeParse('Spring\u2066Launch').success).toBe(
      false,
    );
  });
});

describe('CampaignDescriptionSchema', () => {
  it('accepts newlines, carriage returns and tabs', () => {
    const result = CampaignDescriptionSchema.safeParse('line one\nline two\r\tend');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the description to parse');
    expect(result.data).toBe('line one\nline two\r\tend');
  });

  it('rejects other control characters', () => {
    expect(
      CampaignDescriptionSchema.safeParse('before\u0000after').success,
    ).toBe(false);
    expect(CampaignDescriptionSchema.safeParse('bell\u0007').success).toBe(
      false,
    );
  });

  it('rejects bidi override characters', () => {
    expect(CampaignDescriptionSchema.safeParse('text\u202Etext').success).toBe(
      false,
    );
  });

  it('rejects an empty description', () => {
    expect(CampaignDescriptionSchema.safeParse('').success).toBe(false);
    expect(CampaignDescriptionSchema.safeParse('   ').success).toBe(false);
  });

  it('accepts exactly 2000 characters', () => {
    expect(CampaignDescriptionSchema.safeParse('a'.repeat(2000)).success).toBe(
      true,
    );
  });

  it('rejects 2001 characters', () => {
    expect(CampaignDescriptionSchema.safeParse('a'.repeat(2001)).success).toBe(
      false,
    );
  });
});

describe('CampaignBudgetSchema', () => {
  it.each([
    ['0.01', '0.01'],
    ['1', '1.00'],
    ['100.5', '100.50'],
    ['1234.56', '1234.56'],
    ['9999999999.99', '9999999999.99'],
  ])('accepts %j and round-trips it as %j', (input, expected) => {
    const result = CampaignBudgetSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(`expected ${input} to parse`);
    expect(result.data).toBeInstanceOf(Prisma.Decimal);
    expect(result.data.isNegative()).toBe(false);
    expect(result.data.toFixed(2)).toBe(expected);
  });

  it.each([
    '0',
    '0.00',
    '-1',
    '1.234',
    '1e3',
    '01',
    '.5',
    '1.',
    ' 1',
    '1,000',
    'NaN',
    'Infinity',
    '12345678901',
  ])('rejects the money string %j', (input) => {
    expect(CampaignBudgetSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a JSON number', () => {
    expect(CampaignBudgetSchema.safeParse(100).success).toBe(false);
    expect(CampaignBudgetSchema.safeParse(100.5).success).toBe(false);
  });
});

describe('CreateCampaignBodySchema currency', () => {
  it('defaults the currency to USD when omitted', () => {
    const result = CreateCampaignBodySchema.safeParse(BASE_BODY);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the body to parse');
    expect(result.data.currency).toBe('USD');
    expect(result.data.totalBudget).toBeInstanceOf(Prisma.Decimal);
  });

  it.each(['usd', 'EUR', '', 'USDX'])('rejects the currency %j', (currency) => {
    const result = CreateCampaignBodySchema.safeParse({
      ...BASE_BODY,
      currency,
    });

    expect(result.success).toBe(false);
  });
});

describe('SubmissionDeadlineSchema', () => {
  it('accepts a future ISO string ending in Z', () => {
    const deadline = isoDaysFromNow(10);
    const result = SubmissionDeadlineSchema.safeParse(deadline);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the deadline to parse');
    expect(result.data).toBeInstanceOf(Date);
    expect(result.data.toISOString()).toBe(new Date(deadline).toISOString());
  });

  it('accepts a future ISO string with an explicit offset', () => {
    const deadline = isoDaysFromNow(10).replace(/Z$/, '+05:30');
    const result = SubmissionDeadlineSchema.safeParse(deadline);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the deadline to parse');
    expect(result.data).toBeInstanceOf(Date);
  });

  it('rejects a past date', () => {
    expect(
      SubmissionDeadlineSchema.safeParse('2020-01-01T00:00:00Z').success,
    ).toBe(false);
  });

  it('rejects a date more than 365 days ahead', () => {
    expect(SubmissionDeadlineSchema.safeParse(isoDaysFromNow(400)).success).toBe(
      false,
    );
  });

  it('rejects a date-only string', () => {
    expect(SubmissionDeadlineSchema.safeParse('2030-01-01').success).toBe(
      false,
    );
  });

  it('rejects a calendar-invalid date', () => {
    expect(
      SubmissionDeadlineSchema.safeParse('2030-02-30T00:00:00Z').success,
    ).toBe(false);
  });

  it('rejects a numeric epoch timestamp', () => {
    expect(SubmissionDeadlineSchema.safeParse(Date.now()).success).toBe(false);
  });

  it('rejects a non-ISO string', () => {
    expect(SubmissionDeadlineSchema.safeParse('tomorrow').success).toBe(false);
  });
});

describe('CreateCampaignBodySchema strictness', () => {
  it.each([
    'status',
    'organizationId',
    'id',
    'deletedAt',
    'paidToDate',
    'createdAt',
  ])('rejects the extra key %s', (key) => {
    const result = CreateCampaignBodySchema.safeParse({
      ...BASE_BODY,
      [key]: 'value',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a body with no fields at all', () => {
    expect(CreateCampaignBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('ListCampaignsQuerySchema', () => {
  it('accepts an empty query', () => {
    const result = ListCampaignsQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the query to parse');
    expect(result.data.limit).toBeUndefined();
    expect(result.data.cursor).toBeUndefined();
    expect(result.data.status).toBeUndefined();
  });

  it('accepts a valid limit, cursor and status', () => {
    const result = ListCampaignsQuerySchema.safeParse({
      limit: '2',
      cursor: 'campaign_cursor_1',
      status: 'DRAFT',
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the query to parse');
    expect(result.data.limit).toBe(2);
    expect(result.data.cursor).toBe('campaign_cursor_1');
    expect(result.data.status).toBe('DRAFT');
  });

  it('rejects an unknown campaign status', () => {
    expect(ListCampaignsQuerySchema.safeParse({ status: 'FOO' }).success).toBe(
      false,
    );
  });

  it.each(['0', '51', 'abc', '1e1', '-1'])(
    'rejects the limit %j',
    (limit) => {
      expect(ListCampaignsQuerySchema.safeParse({ limit }).success).toBe(false);
    },
  );

  it('rejects an unknown query key', () => {
    expect(ListCampaignsQuerySchema.safeParse({ page: '1' }).success).toBe(
      false,
    );
  });

  it('rejects a cursor that is not id-shaped', () => {
    expect(
      ListCampaignsQuerySchema.safeParse({ cursor: 'a b' }).success,
    ).toBe(false);
  });
});
