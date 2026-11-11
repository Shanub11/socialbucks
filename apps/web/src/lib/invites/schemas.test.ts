// apps/web/src/lib/invites/schemas.test.ts
//
// Pure unit tests for the invite body schema: no database and no Clerk, so these
// always run (they are NOT gated on RUN_DB_TESTS).

import { describe, expect, it } from 'vitest';

import {
  CreateInviteBodySchema,
  InviteEmailSchema,
  SlotEscrowSchema,
  ViewTargetSchema,
} from './schemas';

/** Exactly 255 characters and otherwise a well-formed address. */
const TOO_LONG_EMAIL = `${'a'.repeat(243)}@example.com`;

function validBody(): Record<string, unknown> {
  return {
    creatorEmail: 'creator@example.com',
    escrowAmount: '40.00',
    viewTarget: 100_000,
  };
}

describe('InviteEmailSchema', () => {
  it('trims surrounding whitespace', () => {
    const result = InviteEmailSchema.safeParse('  creator@example.com  ');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the email to parse');
    expect(result.data).toBe('creator@example.com');
  });

  it('lowercases the address', () => {
    const result = InviteEmailSchema.safeParse('Creator@Example.COM');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the email to parse');
    expect(result.data).toBe('creator@example.com');
  });

  it.each([
    { label: 'an empty string', value: '' },
    { label: 'a non-email string', value: 'not-an-email' },
    { label: 'a domain with no dot', value: 'a@b' },
    { label: 'a 255-char address', value: TOO_LONG_EMAIL },
    { label: 'a number', value: 42 },
    { label: 'null', value: null },
  ])('rejects $label', (testCase) => {
    const result = InviteEmailSchema.safeParse(testCase.value);

    expect(result.success).toBe(false);
  });
});

describe('SlotEscrowSchema', () => {
  it.each(['5.00', '5', '12.5', '9999999999.99'])(
    'accepts the decimal string %s',
    (value) => {
      const result = SlotEscrowSchema.safeParse(value);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected the escrow to parse');
      expect(result.data.toFixed(2).length).toBeGreaterThan(0);
    },
  );

  it('converts to a Decimal with exactly two decimals', () => {
    const result = SlotEscrowSchema.safeParse('5');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the escrow to parse');
    expect(result.data.toFixed(2)).toBe('5.00');
  });

  it.each([
    { label: 'one cent below the minimum', value: '4.99' },
    { label: 'zero', value: '0' },
    { label: 'zero with decimals', value: '0.00' },
    { label: 'a negative amount', value: '-5' },
    { label: 'three decimal places', value: '5.001' },
    { label: 'exponent notation', value: '1e1' },
    { label: 'leading whitespace', value: ' 5' },
    { label: 'a thousands separator', value: '1,000' },
    { label: 'a JSON number', value: 5 },
  ])('rejects $label', (testCase) => {
    const result = SlotEscrowSchema.safeParse(testCase.value);

    expect(result.success).toBe(false);
  });
});

describe('ViewTargetSchema', () => {
  it.each([100, 100_000_000])('accepts the number %s', (value) => {
    const result = ViewTargetSchema.safeParse(value);

    expect(result.success).toBe(true);
  });

  it.each([
    { label: 'one below the minimum', value: 99 },
    { label: 'one above the maximum', value: 100_000_001 },
    { label: 'a fractional count', value: 1.5 },
    { label: 'a negative count', value: -1 },
    { label: 'a numeric string', value: '100' },
    { label: 'NaN', value: Number.NaN },
  ])('rejects $label', (testCase) => {
    const result = ViewTargetSchema.safeParse(testCase.value);

    expect(result.success).toBe(false);
  });
});

describe('CreateInviteBodySchema', () => {
  it('accepts a complete valid body', () => {
    const result = CreateInviteBodySchema.safeParse(validBody());

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the body to parse');
    expect(result.data.creatorEmail).toBe('creator@example.com');
    expect(result.data.escrowAmount.toFixed(2)).toBe('40.00');
    expect(result.data.viewTarget).toBe(100_000);
  });

  it.each([
    'creatorId',
    'status',
    'metric',
    'platform',
    'inviteExpiresAt',
    'organizationId',
    'id',
  ])('rejects the extra key %s', (key) => {
    const result = CreateInviteBodySchema.safeParse({
      ...validBody(),
      [key]: 'value',
    });

    expect(result.success).toBe(false);
  });

  it.each(['creatorEmail', 'escrowAmount', 'viewTarget'])(
    'rejects a body missing %s',
    (key) => {
      const body = validBody();
      delete body[key];

      const result = CreateInviteBodySchema.safeParse(body);

      expect(result.success).toBe(false);
    },
  );
});
