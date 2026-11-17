// apps/web/src/lib/env-isolation.test.ts
//
// The point of the env split: the settlement path must be importable by a process
// that holds the four YouTube settings and nothing else - no Clerk key, no
// Instagram credential. Before the split, every one of these imports threw a
// ZodError listing ten missing variables.
//
// Nothing is mocked here. The real env-parts accessors, the real secret-box and
// the real settlement modules run against a process.env that has had every
// non-YouTube variable removed, which is exactly the worker's situation.

import { SocialPlatform } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The four variables a settlement process is allowed to need. */
const SETTLEMENT_ENV: Record<string, string> = {
  YOUTUBE_CLIENT_ID: 'youtube-client-id-isolation',
  YOUTUBE_CLIENT_SECRET: 'youtube-client-secret-isolation',
  YOUTUBE_REDIRECT_URI: 'https://example.test/auth/youtube',
  YOUTUBE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 0x22).toString('base64'),
};

/** Everything the web app needs and the worker must not. */
const WEB_ONLY_VARIABLES = [
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'INSTAGRAM_APP_ID',
  'INSTAGRAM_APP_SECRET',
  'INSTAGRAM_REDIRECT_URI',
  'INSTAGRAM_TOKEN_ENCRYPTION_KEY',
  'META_APP_SECRET',
];

const KEY_ERROR = 'Invalid encryption key configuration';

const saved = new Map<string, string | undefined>();

/**
 * Leaves process.env with the four settlement variables and nothing else.
 * Overrides are applied last, so a test can install a malformed key.
 */
function applySettlementOnlyEnv(overrides: Record<string, string> = {}): void {
  for (const name of [...Object.keys(SETTLEMENT_ENV), ...WEB_ONLY_VARIABLES]) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
  }
  for (const name of WEB_ONLY_VARIABLES) {
    delete process.env[name];
  }
  Object.assign(process.env, SETTLEMENT_ENV, overrides);
}

// secret-box caches decoded keys per platform, so each case needs a fresh module.
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  saved.clear();
  vi.resetModules();
});

function catchError(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

describe('the settlement path with only YouTube settings', () => {
  it('imports settle-slot, the YouTube adapter and secret-box without Clerk or Instagram settings', async () => {
    applySettlementOnlyEnv();

    await expect(import('@/lib/settlement/settle-slot')).resolves.toBeDefined();
    await expect(import('@/lib/settlement/adapters/youtube')).resolves.toBeDefined();
    await expect(import('@/lib/crypto/secret-box')).resolves.toBeDefined();
  });

  it('round-trips a YouTube token when the Instagram key is absent', async () => {
    applySettlementOnlyEnv();

    const box = await import('@/lib/crypto/secret-box');
    const envelope = box.encryptToken('refresh-token-value', SocialPlatform.YOUTUBE);

    expect(box.decryptToken(envelope, SocialPlatform.YOUTUBE)).toBe('refresh-token-value');
  });

  it('fails closed on Instagram with the existing error when its key is absent', async () => {
    applySettlementOnlyEnv();

    const box = await import('@/lib/crypto/secret-box');
    const error = catchError(() => box.encryptToken('instagram-token', SocialPlatform.INSTAGRAM));

    expect(error).toBeInstanceOf(box.SecretBoxError);
    expect((error as Error).message).toBe(KEY_ERROR);
  });

  it.each([
    { label: 'wrong length (16 bytes)', value: Buffer.alloc(16, 7).toString('base64') },
    { label: '43 characters with an illegal alphabet', value: `${'A'.repeat(42)}!` },
  ])('fails closed on a present but malformed YouTube key: $label', async ({ value }) => {
    applySettlementOnlyEnv({ YOUTUBE_TOKEN_ENCRYPTION_KEY: value });

    const box = await import('@/lib/crypto/secret-box');
    const error = catchError(() => box.encryptToken('refresh-token-value', SocialPlatform.YOUTUBE));

    // Same error type and message as a missing key: the ZodError from the
    // accessor must not escape, and must not be attached as a cause.
    expect(error).toBeInstanceOf(box.SecretBoxError);
    expect((error as Error).message).toBe(KEY_ERROR);
    expect((error as Error).message).not.toContain(value);
    expect((error as Error).cause).toBeUndefined();
  });
});
