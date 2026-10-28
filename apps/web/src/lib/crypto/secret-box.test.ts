import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module caches decoded keys, and lib/env parses at import, so each test
// reloads the module against a mutable mock env that holds DISTINCT keys.
const h = vi.hoisted(() => ({
  platform: { INSTAGRAM: 'INSTAGRAM', YOUTUBE: 'YOUTUBE' } as const,
  env: {
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: '',
    YOUTUBE_TOKEN_ENCRYPTION_KEY: '',
  } as Record<string, string>,
}));

vi.mock('@repo/database', () => ({ SocialPlatform: h.platform }));
vi.mock('@/lib/env', () => ({ env: h.env }));

const IG = h.platform.INSTAGRAM;
const YT = h.platform.YOUTUBE;
const PLATFORMS = [IG, YT] as const;

const KEY_IG = Buffer.alloc(32, 1);
const KEY_YT = Buffer.alloc(32, 2);

// Independent copy of the storage format. If a context string or the envelope
// layout ever changes, every stored token becomes unreadable and these tests fail.
const AAD = {
  INSTAGRAM: 'instagram:long_lived_access_token:v1',
  YOUTUBE: 'youtube:refresh_token:v1',
} as const;

const load = async () => {
  vi.resetModules();
  return import('./secret-box');
};
type SecretBox = Awaited<ReturnType<typeof load>>;

function sealIndependently(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

function openIndependently(key: Buffer, envelope: string, aad: string): string {
  const parts = envelope.split('.');
  expect(parts[0]).toBe('v1');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(parts[1] ?? '', 'base64url'),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(parts[2] ?? '', 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3] ?? '', 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function withSegment(envelope: string, index: number, change: (s: string) => string): string {
  const parts = envelope.split('.');
  parts[index] = change(parts[index] ?? '');
  return parts.join('.');
}

const flipFirstChar = (s: string): string => (s.startsWith('A') ? 'B' : 'A') + s.slice(1);

function catchError(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

function expectSecretBoxError(box: SecretBox, call: () => unknown, message: RegExp): void {
  const error = catchError(call);
  expect(error).toBeInstanceOf(box.SecretBoxError);
  expect(error).toHaveProperty('message', expect.stringMatching(message));
}

const DECRYPTION_FAILED = /^Decryption failed/;
const MALFORMED = /^Malformed ciphertext envelope$/;

beforeEach(() => {
  h.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY = KEY_IG.toString('base64');
  h.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = KEY_YT.toString('base64');
});

describe('secret-box round trips', () => {
  it.each(PLATFORMS)('round-trips unicode text on %s', async (platform) => {
    const box = await load();
    const plaintext = 'ya29.refresh-\u00dcn\u00efc\u00f6d\u00e9-\u65e5\u672c\u8a9e-\u{1F642}';
    expect(box.decryptToken(box.encryptToken(plaintext, platform), platform)).toBe(plaintext);
  });

  it.each(PLATFORMS)('round-trips a 4 KB token on %s', async (platform) => {
    const box = await load();
    const plaintext = 't'.repeat(4096);
    expect(box.decryptToken(box.encryptToken(plaintext, platform), platform)).toBe(plaintext);
  });

  it('low-level encryptSecret/decryptSecret round-trip under the same context', async () => {
    const box = await load();
    const envelope = box.encryptSecret('low-level-secret', 'context-a');
    expect(box.decryptSecret(envelope, 'context-a')).toBe('low-level-secret');
  });
});

describe('secret-box encryption properties', () => {
  it.each(PLATFORMS)('encryptToken refuses an empty token on %s', async (platform) => {
    const box = await load();
    expectSecretBoxError(box, () => box.encryptToken('', platform), /^Refusing to encrypt an empty token$/);
  });

  it('encryptSecret refuses an empty secret', async () => {
    const box = await load();
    expectSecretBoxError(box, () => box.encryptSecret('', 'context-a'), /^Refusing to encrypt an empty secret$/);
  });

  it('uses a fresh IV, so the same plaintext never produces the same ciphertext', async () => {
    const box = await load();
    const a = box.encryptToken('same-plaintext', IG);
    const b = box.encryptToken('same-plaintext', IG);
    expect(a).not.toBe(b);
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
  });

  it('produces v1.<iv>.<tag>.<ciphertext> with a 12-byte iv and 16-byte tag', async () => {
    const box = await load();
    const parts = box.encryptToken('shape-check', YT).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1] ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2] ?? '', 'base64url')).toHaveLength(16);
  });
});

describe('secret-box platform and context isolation', () => {
  it('an Instagram ciphertext does not decrypt as YouTube', async () => {
    const box = await load();
    const envelope = box.encryptToken('ig-secret', IG);
    expectSecretBoxError(box, () => box.decryptToken(envelope, YT), DECRYPTION_FAILED);
  });

  it('a YouTube ciphertext does not decrypt as Instagram', async () => {
    const box = await load();
    const envelope = box.encryptToken('yt-secret', YT);
    expectSecretBoxError(box, () => box.decryptToken(envelope, IG), DECRYPTION_FAILED);
  });

  it('refuses to encrypt when both platforms share one key', async () => {
    h.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = KEY_IG.toString('base64');
    const box = await load();
    expectSecretBoxError(box, () => box.encryptToken('ig-secret', IG), /^Platform encryption keys must be different$/);
    expectSecretBoxError(box, () => box.encryptToken('yt-secret', YT), /^Platform encryption keys must be different$/);
  });

  it('decryptSecret fails under a different context', async () => {
    const box = await load();
    const envelope = box.encryptSecret('low-level-secret', 'context-a');
    expectSecretBoxError(box, () => box.decryptSecret(envelope, 'context-b'), DECRYPTION_FAILED);
  });
});

describe('secret-box tampering and malformed input', () => {
  it('rejects an unsupported version segment', async () => {
    const box = await load();
    const envelope = withSegment(box.encryptToken('secret-value', IG), 0, () => 'v99');
    expectSecretBoxError(box, () => box.decryptToken(envelope, IG), /^Unsupported ciphertext version: v99$/);
  });

  it.each([
    { name: 'iv', index: 1 },
    { name: 'tag', index: 2 },
    { name: 'ciphertext', index: 3 },
  ])('rejects a tampered $name segment', async ({ index }) => {
    const box = await load();
    const envelope = withSegment(box.encryptToken('secret-value', IG), index, flipFirstChar);
    expectSecretBoxError(box, () => box.decryptToken(envelope, IG), DECRYPTION_FAILED);
  });

  it.each([
    { name: 'a three-segment envelope', build: (v: string) => v.split('.').slice(0, 3).join('.') },
    { name: 'a five-segment envelope', build: (v: string) => `${v}.extra` },
    { name: 'an empty string', build: () => '' },
    { name: 'four empty segments', build: () => 'v1...' },
    { name: 'a wrong-length iv', build: (v: string) => withSegment(v, 1, (s) => s.slice(4)) },
    { name: 'a wrong-length tag', build: (v: string) => withSegment(v, 2, (s) => s.slice(4)) },
    { name: 'non-base64 segments', build: () => 'v1.!!!.@@@.###' },
  ])('rejects $name as malformed', async ({ build }) => {
    const box = await load();
    const envelope = build(box.encryptToken('secret-value', IG));
    expectSecretBoxError(box, () => box.decryptToken(envelope, IG), MALFORMED);
  });
});

describe('secret-box key handling', () => {
  // getPlatformKey now rejects missing or wrong-length keys with a SecretBoxError (see
  // 'secret-box key validation' below); these two tests stay as a coarse fail-closed check.
  it('fails closed when a platform key is missing', async () => {
    Reflect.deleteProperty(h.env, 'YOUTUBE_TOKEN_ENCRYPTION_KEY');
    const box = await load();
    const error = catchError(() => box.encryptToken('plaintext-value', YT));
    expect(error).toBeInstanceOf(Error);
  });

  it('fails closed on a wrong-length key without leaking it', async () => {
    const shortKey = Buffer.alloc(16, 7).toString('base64');
    h.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY = shortKey;
    const box = await load();
    const error = catchError(() => box.encryptToken('plaintext-value', IG));
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', expect.not.stringContaining(shortKey));
  });
});

describe('secret-box error hygiene', () => {
  it('never puts the plaintext, the key or the ciphertext in an error message', async () => {
    const box = await load();
    const secret = 'SUPER-SECRET-REFRESH-TOKEN-1234567890';
    const envelope = box.encryptToken(secret, YT);
    const errors = [
      catchError(() => box.decryptToken(withSegment(envelope, 3, flipFirstChar), YT)),
      catchError(() => box.decryptToken(envelope, IG)),
      catchError(() => box.decryptToken(withSegment(envelope, 0, () => 'v99'), YT)),
    ];
    for (const error of errors) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(KEY_YT.toString('base64'));
      expect(message).not.toContain(KEY_YT.toString('hex'));
      expect(message).not.toContain(envelope.split('.')[3] ?? 'missing');
    }
  });
});

describe('secret-box compatibility with stored data', () => {
  it.each(PLATFORMS)('decrypts an envelope sealed independently with node:crypto (%s)', async (platform) => {
    const box = await load();
    const key = platform === IG ? KEY_IG : KEY_YT;
    const envelope = sealIndependently(key, 'stored-in-the-database', AAD[platform]);
    expect(box.decryptToken(envelope, platform)).toBe('stored-in-the-database');
  });

  it.each(PLATFORMS)('encrypts in the documented format that node:crypto can open (%s)', async (platform) => {
    const box = await load();
    const key = platform === IG ? KEY_IG : KEY_YT;
    const envelope = box.encryptToken('written-by-the-app', platform);
    expect(openIndependently(key, envelope, AAD[platform])).toBe('written-by-the-app');
  });
});
describe('secret-box legacy low-level API compatibility', () => {
  // lib/instagram/connection.ts still reads Instagram tokens with decryptSecret(...) and the
  // constant TOKEN_ENCRYPTION_CONTEXT, while new writes use encryptToken. That only works
  // because both use the Instagram key and the same context string; pin it so neither drifts.
  it('decryptSecret opens what encryptToken wrote for Instagram', async () => {
    const box = await load();
    const envelope = box.encryptToken('ig-long-lived-token', IG);
    expect(box.decryptSecret(envelope, AAD.INSTAGRAM)).toBe('ig-long-lived-token');
  });

  it('encryptToken opens what encryptSecret wrote under the Instagram context', async () => {
    const box = await load();
    const envelope = box.encryptSecret('ig-long-lived-token', AAD.INSTAGRAM);
    expect(box.decryptToken(envelope, IG)).toBe('ig-long-lived-token');
  });
});
describe('secret-box legacy low-level API compatibility', () => {
  // lib/instagram/connection.ts still reads Instagram tokens with decryptSecret(...) and the
  // constant TOKEN_ENCRYPTION_CONTEXT, while new writes use encryptToken. That only works
  // because both use the Instagram key and the same context string; pin it so neither drifts.
  it('decryptSecret opens what encryptToken wrote for Instagram', async () => {
    const box = await load();
    const envelope = box.encryptToken('ig-long-lived-token', IG);
    expect(box.decryptSecret(envelope, AAD.INSTAGRAM)).toBe('ig-long-lived-token');
  });

  it('encryptToken opens what encryptSecret wrote under the Instagram context', async () => {
    const box = await load();
    const envelope = box.encryptSecret('ig-long-lived-token', AAD.INSTAGRAM);
    expect(box.decryptToken(envelope, IG)).toBe('ig-long-lived-token');
  });
});
describe('secret-box key validation', () => {
  const KEY_ERROR = /^Invalid encryption key configuration$/;
  const INVALID_KEYS = [
    { name: 'missing', value: undefined },
    { name: 'empty', value: '' },
    { name: '16 bytes long', value: Buffer.alloc(16, 7).toString('base64') },
    { name: '33 bytes long', value: Buffer.alloc(33, 7).toString('base64') },
  ];

  function setKey(name: string, value: string | undefined): void {
    if (value === undefined) {
      Reflect.deleteProperty(h.env, name);
    } else {
      h.env[name] = value;
    }
  }

  it.each(INVALID_KEYS)('encryptToken rejects a $name Instagram key with a SecretBoxError', async ({ value }) => {
    setKey('INSTAGRAM_TOKEN_ENCRYPTION_KEY', value);
    const box = await load();
    expectSecretBoxError(box, () => box.encryptToken('plaintext-value', IG), KEY_ERROR);
  });

  it.each(INVALID_KEYS)('encryptToken rejects a $name YouTube key with a SecretBoxError', async ({ value }) => {
    setKey('YOUTUBE_TOKEN_ENCRYPTION_KEY', value);
    const box = await load();
    expectSecretBoxError(box, () => box.encryptToken('plaintext-value', YT), KEY_ERROR);
  });

  it.each(INVALID_KEYS)('decryptToken rejects a $name Instagram key with a SecretBoxError', async ({ value }) => {
    setKey('INSTAGRAM_TOKEN_ENCRYPTION_KEY', value);
    const box = await load();
    expectSecretBoxError(box, () => box.decryptToken('v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', IG), KEY_ERROR);
  });
});