// apps/web/src/lib/slots/schemas.test.ts
//
// Pure unit tests for the slots invite schemas: no database, no Clerk, so these
// always run (they are NOT gated on RUN_DB_TESTS).

import { describe, expect, it } from 'vitest';

import { MAX_PAGE_SIZE } from '@/lib/orgs/constants';
import { ListMyInvitesQuerySchema, SlotIdParamSchema } from './schemas';

describe('SlotIdParamSchema', () => {
  it('accepts an id-shaped string', () => {
    expect(SlotIdParamSchema.parse('slot_abc123')).toBe('slot_abc123');
    expect(SlotIdParamSchema.parse('org_ABC-123')).toBe('org_ABC-123');
  });

  it('rejects malformed ids', () => {
    for (const id of ['', 'a b', '../x', 'a/b', 'x'.repeat(65), 'org.id']) {
      expect(SlotIdParamSchema.safeParse(id).success).toBe(false);
    }
  });
});

describe('ListMyInvitesQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(ListMyInvitesQuerySchema.parse({})).toEqual({});
  });

  it('coerces a valid limit to a number', () => {
    expect(ListMyInvitesQuerySchema.parse({ limit: '1' })).toEqual({ limit: 1 });
    expect(ListMyInvitesQuerySchema.parse({ limit: String(MAX_PAGE_SIZE) })).toEqual({
      limit: MAX_PAGE_SIZE,
    });
  });

  it('accepts a valid cursor, alone and with a limit', () => {
    expect(ListMyInvitesQuerySchema.parse({ cursor: 'clx1234567890' })).toEqual({
      cursor: 'clx1234567890',
    });
    expect(
      ListMyInvitesQuerySchema.parse({ limit: '2', cursor: 'clx1234567890' }),
    ).toEqual({ limit: 2, cursor: 'clx1234567890' });
  });

  it('rejects out-of-range and non-integer limits', () => {
    for (const limit of ['0', '51', 'abc', '1e1', '-1', ' 5', '1.5', '']) {
      expect(ListMyInvitesQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it('rejects unknown keys', () => {
    expect(ListMyInvitesQuerySchema.safeParse({ page: '1' }).success).toBe(false);
  });

  it('rejects cursors that are not id-shaped', () => {
    for (const cursor of ['a/b', 'a b', 'x'.repeat(65), '', '../x']) {
      expect(ListMyInvitesQuerySchema.safeParse({ cursor }).success).toBe(false);
    }
  });
});