// apps/web/src/lib/orgs/schemas.test.ts
//
// Pure unit tests for the organization schemas: no database, no Clerk, so these
// always run (they are NOT gated on RUN_DB_TESTS).

import { describe, expect, it } from 'vitest';

import { MAX_ORG_NAME_LENGTH, MAX_PAGE_SIZE } from './constants';
import {
  CreateOrgBodySchema,
  ListOrgsQuerySchema,
  OrgIdParamSchema,
  OrgNameSchema,
} from './schemas';

describe('OrgNameSchema', () => {
  it('trims surrounding whitespace', () => {
    expect(OrgNameSchema.parse('  Acme Ltd  ')).toBe('Acme Ltd');
  });

  it('normalizes to NFC before validating', () => {
    // 'e' + U+0301 (combining acute) becomes the single code point 'é'.
    const parsed = OrgNameSchema.parse('Cafe\u0301');

    expect(parsed).toBe('Café');
    expect(parsed).toHaveLength(4);
  });

  it('rejects an empty name', () => {
    expect(OrgNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects a whitespace-only name', () => {
    expect(OrgNameSchema.safeParse('   ').success).toBe(false);
  });

  it(`accepts exactly ${MAX_ORG_NAME_LENGTH} characters`, () => {
    const name = 'a'.repeat(MAX_ORG_NAME_LENGTH);

    expect(OrgNameSchema.parse(name)).toBe(name);
  });

  it(`rejects ${MAX_ORG_NAME_LENGTH + 1} characters`, () => {
    expect(
      OrgNameSchema.safeParse('a'.repeat(MAX_ORG_NAME_LENGTH + 1)).success,
    ).toBe(false);
  });

  it('rejects control characters', () => {
    for (const value of ['\u0000', '\n', '\t', '\u007f']) {
      expect(OrgNameSchema.safeParse(`Acme${value}Ltd`).success).toBe(false);
    }
  });

  it('rejects bidi override and isolate characters', () => {
    for (const value of ['\u202A', '\u202E', '\u2066', '\u2069']) {
      expect(OrgNameSchema.safeParse(`Acme${value}Ltd`).success).toBe(false);
    }
  });

  it('rejects non-string values', () => {
    for (const value of [null, undefined, 42, true, [], {}]) {
      expect(OrgNameSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('CreateOrgBodySchema', () => {
  it('accepts and normalizes a name', () => {
    expect(CreateOrgBodySchema.parse({ name: '  Acme  ' })).toEqual({
      name: 'Acme',
    });
  });

  it('rejects a body without a name', () => {
    expect(CreateOrgBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-string name', () => {
    expect(CreateOrgBodySchema.safeParse({ name: 42 }).success).toBe(false);
  });

  it('rejects mass-assignment keys', () => {
    for (const key of ['role', 'id', 'clerkOrgId', 'deletedAt', 'organizationId']) {
      expect(
        CreateOrgBodySchema.safeParse({ name: 'Acme', [key]: 'x' }).success,
      ).toBe(false);
    }
  });
});

describe('ListOrgsQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(ListOrgsQuerySchema.parse({})).toEqual({});
  });

  it('coerces a valid limit to a number', () => {
    expect(ListOrgsQuerySchema.parse({ limit: '1' })).toEqual({ limit: 1 });
    expect(ListOrgsQuerySchema.parse({ limit: String(MAX_PAGE_SIZE) })).toEqual({
      limit: MAX_PAGE_SIZE,
    });
  });

  it('accepts a valid cursor, alone and with a limit', () => {
    expect(ListOrgsQuerySchema.parse({ cursor: 'clx1234567890' })).toEqual({
      cursor: 'clx1234567890',
    });
    expect(
      ListOrgsQuerySchema.parse({ limit: '2', cursor: 'clx1234567890' }),
    ).toEqual({ limit: 2, cursor: 'clx1234567890' });
  });

  it('rejects out-of-range and non-integer limits', () => {
    for (const limit of ['0', '51', 'abc', '1e1', '-1', ' 5', '1.5', '']) {
      expect(ListOrgsQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it('rejects unknown keys', () => {
    expect(ListOrgsQuerySchema.safeParse({ page: '1' }).success).toBe(false);
  });

  it('rejects cursors that are not id-shaped', () => {
    for (const cursor of ['a/b', 'a b', 'x'.repeat(65), '', '../x']) {
      expect(ListOrgsQuerySchema.safeParse({ cursor }).success).toBe(false);
    }
  });
});

describe('OrgIdParamSchema', () => {
  it('accepts an id-shaped string', () => {
    expect(OrgIdParamSchema.parse('clx1234567890')).toBe('clx1234567890');
    expect(OrgIdParamSchema.parse('org_ABC-123')).toBe('org_ABC-123');
  });

  it('rejects malformed ids', () => {
    for (const id of ['', 'a b', '../x', 'a/b', 'x'.repeat(65), 'org.id']) {
      expect(OrgIdParamSchema.safeParse(id).success).toBe(false);
    }
  });
});
