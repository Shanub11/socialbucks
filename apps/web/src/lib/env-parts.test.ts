// apps/web/src/lib/env-parts.test.ts
//
// Two things are proved here, both pure:
//
//   1. Rule parity. Every variable is checked by one rule in env-parts.ts, and
//      env.ts composes those same rules into the schema it boots with. A table of
//      values is run through both, and they must agree on accept or reject - so
//      the split cannot quietly give the worker a laxer or stricter rule than the
//      web app.
//
//   2. parseSettlementEnv. This is the only gate between a settlement process and
//      a half-configured key: it names what is missing, rejects a malformed key,
//      allows an absent Instagram key, and never prints a value.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { env, envSchema } from '@/lib/env';
import { envParts, parseSettlementEnv } from '@/lib/env-parts';

const KEY_IG = Buffer.alloc(32, 0x11).toString('base64');
const KEY_YT = Buffer.alloc(32, 0x22).toString('base64');
const KEY_IG_OTHER = Buffer.alloc(32, 0x44).toString('base64');
const KEY_YT_OTHER = Buffer.alloc(32, 0x33).toString('base64');
const KEY_SHORT = Buffer.alloc(16, 0x55).toString('base64');
/** 43 characters, so long enough, but '!' is not in the base64 alphabet. */
const KEY_BAD_ALPHABET = `${'A'.repeat(42)}!`;

/** A complete, valid environment: the base every parity case is applied to. */
const BASE_ENV: Record<string, string | undefined> = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_parity',
  CLERK_SECRET_KEY: 'sk_test_parity',
  CLERK_WEBHOOK_SIGNING_SECRET: undefined,
  INSTAGRAM_APP_ID: 'instagram-app-id',
  INSTAGRAM_APP_SECRET: 'instagram-app-secret',
  INSTAGRAM_REDIRECT_URI: 'https://example.test/auth/instagram',
  INSTAGRAM_TOKEN_ENCRYPTION_KEY: KEY_IG,
  META_APP_SECRET: undefined,
  YOUTUBE_CLIENT_ID: 'youtube-client-id',
  YOUTUBE_CLIENT_SECRET: 'youtube-client-secret',
  YOUTUBE_REDIRECT_URI: 'https://example.test/auth/youtube',
  YOUTUBE_TOKEN_ENCRYPTION_KEY: KEY_YT,
};

// ---------------------------------------------------------------------------
// Rule parity
// ---------------------------------------------------------------------------

interface ParityCase {
  variable: keyof typeof envParts;
  label: string;
  value: string | undefined;
}

// Key values that are valid stay distinct from BASE_ENV's other key, so the
// cross-platform check never decides a per-variable case.
const PARITY_CASES: ParityCase[] = [
  { variable: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', label: 'valid', value: 'pk_test_parity_2' },
  { variable: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', label: 'empty', value: '' },
  { variable: 'CLERK_SECRET_KEY', label: 'valid', value: 'sk_test_parity_2' },
  { variable: 'CLERK_SECRET_KEY', label: 'empty', value: '' },
  { variable: 'CLERK_WEBHOOK_SIGNING_SECRET', label: 'present', value: 'whsec_parity' },
  { variable: 'CLERK_WEBHOOK_SIGNING_SECRET', label: 'absent', value: undefined },
  { variable: 'INSTAGRAM_APP_ID', label: 'valid', value: 'instagram-app-id-2' },
  { variable: 'INSTAGRAM_APP_ID', label: 'empty', value: '' },
  { variable: 'INSTAGRAM_APP_SECRET', label: 'valid', value: 'instagram-app-secret-2' },
  { variable: 'INSTAGRAM_APP_SECRET', label: 'absent', value: undefined },
  { variable: 'INSTAGRAM_REDIRECT_URI', label: 'valid', value: 'https://example.test/auth/instagram-2' },
  { variable: 'INSTAGRAM_REDIRECT_URI', label: 'non-https', value: 'http://example.test/auth/instagram' },
  { variable: 'INSTAGRAM_REDIRECT_URI', label: 'trailing slash', value: 'https://example.test/auth/instagram/' },
  { variable: 'INSTAGRAM_REDIRECT_URI', label: 'not an absolute URL', value: 'https://not a url' },
  { variable: 'INSTAGRAM_TOKEN_ENCRYPTION_KEY', label: 'valid', value: KEY_IG_OTHER },
  { variable: 'INSTAGRAM_TOKEN_ENCRYPTION_KEY', label: '16 bytes', value: KEY_SHORT },
  { variable: 'INSTAGRAM_TOKEN_ENCRYPTION_KEY', label: 'illegal alphabet', value: KEY_BAD_ALPHABET },
  { variable: 'META_APP_SECRET', label: 'present', value: 'meta-app-secret' },
  { variable: 'META_APP_SECRET', label: 'absent', value: undefined },
  { variable: 'YOUTUBE_CLIENT_ID', label: 'valid', value: 'youtube-client-id-2' },
  { variable: 'YOUTUBE_CLIENT_ID', label: 'empty', value: '' },
  { variable: 'YOUTUBE_CLIENT_SECRET', label: 'valid', value: 'youtube-client-secret-2' },
  { variable: 'YOUTUBE_CLIENT_SECRET', label: 'absent', value: undefined },
  { variable: 'YOUTUBE_REDIRECT_URI', label: 'valid', value: 'https://example.test/auth/youtube-2' },
  { variable: 'YOUTUBE_REDIRECT_URI', label: 'non-https', value: 'http://example.test/auth/youtube' },
  { variable: 'YOUTUBE_REDIRECT_URI', label: 'trailing slash', value: 'https://example.test/auth/youtube/' },
  { variable: 'YOUTUBE_TOKEN_ENCRYPTION_KEY', label: 'valid', value: KEY_YT_OTHER },
  { variable: 'YOUTUBE_TOKEN_ENCRYPTION_KEY', label: '33 bytes', value: Buffer.alloc(33, 0x66).toString('base64') },
  { variable: 'YOUTUBE_TOKEN_ENCRYPTION_KEY', label: 'illegal alphabet', value: KEY_BAD_ALPHABET },
];

describe('per-variable rules agree with the schema env.ts boots with', () => {
  it.each(PARITY_CASES)('$variable: $label', ({ variable, value }) => {
    const single = (envParts[variable] as unknown as z.ZodType).safeParse(value);
    const composed = envSchema.safeParse({ ...BASE_ENV, [variable]: value });

    expect(composed.success).toBe(single.success);
  });
});

describe('env.ts', () => {
  it('still parses every variable at import', () => {
    // The module was imported above with the test environment; if the composed
    // schema had lost a variable, the parse would not have produced it.
    expect(Object.keys(env).sort()).toEqual(
      [
        'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
        'CLERK_SECRET_KEY',
        'CLERK_WEBHOOK_SIGNING_SECRET',
        'INSTAGRAM_APP_ID',
        'INSTAGRAM_APP_SECRET',
        'INSTAGRAM_REDIRECT_URI',
        'INSTAGRAM_TOKEN_ENCRYPTION_KEY',
        'META_APP_SECRET',
        'YOUTUBE_CLIENT_ID',
        'YOUTUBE_CLIENT_SECRET',
        'YOUTUBE_REDIRECT_URI',
        'YOUTUBE_TOKEN_ENCRYPTION_KEY',
      ].sort(),
    );
    expect(env.YOUTUBE_TOKEN_ENCRYPTION_KEY).toBe(process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY);
  });
});

// ---------------------------------------------------------------------------
// parseSettlementEnv
// ---------------------------------------------------------------------------

const SETTLEMENT_ENV: Record<string, string> = {
  YOUTUBE_CLIENT_ID: 'youtube-client-id',
  YOUTUBE_CLIENT_SECRET: 'youtube-client-secret',
  YOUTUBE_REDIRECT_URI: 'https://example.test/auth/youtube',
  YOUTUBE_TOKEN_ENCRYPTION_KEY: KEY_YT,
};

const REQUIRED_VARIABLES = [
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REDIRECT_URI',
  'YOUTUBE_TOKEN_ENCRYPTION_KEY',
] as const;

function parseError(source: Record<string, string | undefined>): z.ZodError {
  try {
    parseSettlementEnv(source);
  } catch (error) {
    if (error instanceof z.ZodError) return error;
    throw error;
  }
  throw new Error('expected parseSettlementEnv to throw, but it returned');
}

describe('parseSettlementEnv', () => {
  it.each(REQUIRED_VARIABLES)('names %s when it is missing', (variable) => {
    const source: Record<string, string | undefined> = { ...SETTLEMENT_ENV };
    delete source[variable];

    const error = parseError(source);

    const mentions = error.issues.some(
      (issue) => issue.path.join('.') === variable || issue.message.includes(variable),
    );
    expect(mentions).toBe(true);
  });

  it('accepts the four YouTube variables with no Instagram key at all', () => {
    const parsed = parseSettlementEnv(SETTLEMENT_ENV);

    expect(parsed.YOUTUBE_CLIENT_ID).toBe(SETTLEMENT_ENV.YOUTUBE_CLIENT_ID);
    expect(parsed.YOUTUBE_TOKEN_ENCRYPTION_KEY).toBe(KEY_YT);
    expect(parsed.INSTAGRAM_TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it.each([
    { label: 'wrong length (16 bytes)', value: KEY_SHORT },
    { label: '43 characters with an illegal alphabet', value: KEY_BAD_ALPHABET },
  ])('rejects a malformed YouTube key: $label', ({ value }) => {
    const error = parseError({ ...SETTLEMENT_ENV, YOUTUBE_TOKEN_ENCRYPTION_KEY: value });

    expect(error.issues.some((issue) => issue.path.join('.') === 'YOUTUBE_TOKEN_ENCRYPTION_KEY')).toBe(true);
  });

  it('rejects an Instagram key that decodes to the YouTube key', () => {
    // The same 32 bytes written with and without base64 padding. A raw-string
    // comparison would accept this pair; decoded comparison must not.
    const unpadded = KEY_YT.replace(/=+$/, '');
    expect(unpadded).not.toBe(KEY_YT);
    expect(Buffer.from(unpadded, 'base64').equals(Buffer.from(KEY_YT, 'base64'))).toBe(true);

    const error = parseError({ ...SETTLEMENT_ENV, INSTAGRAM_TOKEN_ENCRYPTION_KEY: unpadded });

    expect(
      error.issues.some((issue) => issue.message.includes('must differ from INSTAGRAM_TOKEN_ENCRYPTION_KEY')),
    ).toBe(true);
  });

  it('keeps every configured value out of the error it throws', () => {
    const canary = 'CANARY_key_3fa';
    const error = parseError({
      YOUTUBE_CLIENT_ID: canary,
      YOUTUBE_CLIENT_SECRET: canary,
      YOUTUBE_REDIRECT_URI: `http://${canary}`, // rejected: not HTTPS
      YOUTUBE_TOKEN_ENCRYPTION_KEY: canary, // rejected: not base64
      INSTAGRAM_TOKEN_ENCRYPTION_KEY: canary, // rejected: not base64
    });

    const serialized = `${error.message}\n${JSON.stringify(error.issues)}`;
    expect(serialized).not.toContain(canary);
  });
});
