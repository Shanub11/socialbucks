// apps/web/src/lib/slots/reject-schemas.test.ts
//
// Pure unit tests for the rejection schemas: no database, no Clerk, so these
// always run (they are NOT gated on RUN_DB_TESTS).

import { describe, expect, it } from 'vitest';

import {
  MAX_REJECTION_REASON_LENGTH,
  RejectSlotBodySchema,
  RejectionReasonSchema,
} from './reject-schemas';

const MAX_REASON = 'a'.repeat(MAX_REJECTION_REASON_LENGTH);
const OVERLONG_REASON = 'a'.repeat(MAX_REJECTION_REASON_LENGTH + 1);

describe('RejectionReasonSchema', () => {
  it('trims surrounding whitespace', () => {
    const result = RejectionReasonSchema.safeParse('  Not a Short  ');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the reason to parse');
    expect(result.data).toBe('Not a Short');
  });

  it('NFC-normalizes the reason', () => {
    const result = RejectionReasonSchema.safeParse('Cafe\u0301');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the reason to parse');
    expect(result.data).toBe('Caf\u00e9');
  });

  it('accepts newlines and tabs inside the reason', () => {
    const result = RejectionReasonSchema.safeParse(
      'Line one\nLine two\r\n\tIndented',
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the reason to parse');
    expect(result.data).toBe('Line one\nLine two\r\n\tIndented');
  });

  it('accepts exactly the maximum length', () => {
    const result = RejectionReasonSchema.safeParse(MAX_REASON);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the reason to parse');
    expect(result.data).toHaveLength(MAX_REJECTION_REASON_LENGTH);
  });

  it.each([
    { label: 'an empty string', value: '' },
    { label: 'whitespace only', value: '   \n\t  ' },
    { label: 'one character over the maximum', value: OVERLONG_REASON },
    { label: 'a NUL control character', value: 'bad\u0000reason' },
    { label: 'a right-to-left override', value: 'bad\u202Ereason' },
    { label: 'a left-to-right isolate', value: 'bad\u2066reason' },
    { label: 'a number', value: 5 },
    { label: 'null', value: null },
    { label: 'an object', value: { reason: 'nested' } },
  ])('rejects $label', (testCase) => {
    const result = RejectionReasonSchema.safeParse(testCase.value);

    expect(result.success).toBe(false);
  });
});

describe('RejectSlotBodySchema', () => {
  it('accepts a valid body', () => {
    const result = RejectSlotBodySchema.safeParse({ reason: 'Not a Short' });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected the body to parse');
    expect(result.data).toEqual({ reason: 'Not a Short' });
  });

  it.each([
    'status',
    'rejectedAt',
    'rejectionReason',
    'viewTarget',
    'creatorId',
  ])('rejects the extra key %s', (key) => {
    const result = RejectSlotBodySchema.safeParse({
      reason: 'Not a Short',
      [key]: 'value',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a body missing the reason', () => {
    expect(RejectSlotBodySchema.safeParse({}).success).toBe(false);
  });
});
