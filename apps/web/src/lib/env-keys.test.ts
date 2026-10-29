import { afterEach, describe, expect, it, vi } from 'vitest';

// The real env module, parsed fresh each time, so these tests prove the app refuses to
// boot when both platforms are configured with the same encryption key.
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const original = {
  instagram: process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY,
  youtube: process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY,
};

function setKeys(instagram: string, youtube: string): void {
  process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY = instagram;
  process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = youtube;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv('INSTAGRAM_TOKEN_ENCRYPTION_KEY', original.instagram);
  restoreEnv('YOUTUBE_TOKEN_ENCRYPTION_KEY', original.youtube);
  vi.resetModules();
});

describe('env token encryption keys', () => {
  it('loads when the two platform keys are different', async () => {
    setKeys(KEY_A, KEY_B);
    vi.resetModules();
    const { env } = await import('@/lib/env');
    expect(env.INSTAGRAM_TOKEN_ENCRYPTION_KEY).toBe(KEY_A);
    expect(env.YOUTUBE_TOKEN_ENCRYPTION_KEY).toBe(KEY_B);
  });

  it('refuses to load when both platforms use the same key', async () => {
    setKeys(KEY_A, KEY_A);
    vi.resetModules();
    await expect(import('@/lib/env')).rejects.toThrow(/must differ from INSTAGRAM_TOKEN_ENCRYPTION_KEY/);
  });

  it('does not put the key in the error message', async () => {
    setKeys(KEY_A, KEY_A);
    vi.resetModules();
    let message = '';
    try {
      await import('@/lib/env');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(KEY_A);
  });
});