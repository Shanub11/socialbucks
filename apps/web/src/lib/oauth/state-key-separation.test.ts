import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real secret-box and real state modules, with only the environment and the database
// package mocked, so these tests prove how the actual signing keys behave when keys change.
const h = vi.hoisted(() => ({
  platform: { INSTAGRAM: 'INSTAGRAM', YOUTUBE: 'YOUTUBE' } as const,
  env: {
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: '',
    YOUTUBE_TOKEN_ENCRYPTION_KEY: '',
  } as Record<string, string>,
}));

vi.mock('@repo/database', () => ({ SocialPlatform: h.platform }));
vi.mock('@/lib/env', () => ({ env: h.env }));

const KEY_IG = Buffer.alloc(32, 1);
const KEY_YT = Buffer.alloc(32, 2);
const KEY_OTHER = Buffer.alloc(32, 3);
const LABEL_YT = 'socialbucks:oauth-state:v1';
const LABEL_IG = 'socialbucks:instagram-oauth-state:v1';
const USER = 'user_2abcDEF123';

const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const expectedSignature = (baseKey: Buffer, label: string, body: string): string =>
  createHmac('sha256', hmac(baseKey, label)).update(body).digest('base64url');
const bodyOf = (state: string): string => state.split('.')[0] ?? '';
const signatureOf = (state: string): string => state.split('.')[1] ?? '';

function setKeys(instagram: Buffer, youtube: Buffer): void {
  h.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY = instagram.toString('base64');
  h.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = youtube.toString('base64');
}

// The modules cache decoded keys, so every key change needs a fresh import.
async function loadModules() {
  vi.resetModules();
  const generic = await import('@/lib/oauth/state');
  const instagram = await import('@/lib/instagram/oauth-state');
  const box = await import('@/lib/crypto/secret-box');
  return { generic, instagram, box };
}

beforeEach(() => {
  setKeys(KEY_IG, KEY_YT);
});

describe('OAuth state signing keys', () => {
  it('signs YouTube states under a key derived from the YouTube token key', async () => {
    const { generic } = await loadModules();
    const { state } = generic.createOAuthState(USER);
    expect(signatureOf(state)).toBe(expectedSignature(KEY_YT, LABEL_YT, bodyOf(state)));
  });

  it('still signs Instagram states under a key derived from the Instagram token key (unchanged)', async () => {
    const { instagram } = await loadModules();
    const { state } = instagram.createOAuthState(USER);
    expect(signatureOf(state)).toBe(expectedSignature(KEY_IG, LABEL_IG, bodyOf(state)));
  });

  it('keeps a YouTube state valid when only the Instagram key changes', async () => {
    const before = await loadModules();
    const { state, nonce } = before.generic.createOAuthState(USER);
    setKeys(KEY_OTHER, KEY_YT);
    const after = await loadModules();
    expect(after.generic.verifyOAuthState(state, nonce, USER)).toEqual({ ok: true });
  });

  it('rejects a YouTube state when the YouTube key changes', async () => {
    const before = await loadModules();
    const { state, nonce } = before.generic.createOAuthState(USER);
    setKeys(KEY_IG, KEY_OTHER);
    const after = await loadModules();
    expect(after.generic.verifyOAuthState(state, nonce, USER)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('keeps an Instagram state valid when only the YouTube key changes', async () => {
    const before = await loadModules();
    const { state, nonce } = before.instagram.createOAuthState(USER);
    setKeys(KEY_IG, KEY_OTHER);
    const after = await loadModules();
    expect(after.instagram.verifyOAuthState(state, nonce, USER)).toEqual({ ok: true });
  });

  it('rejects an Instagram state when the Instagram key changes', async () => {
    const before = await loadModules();
    const { state, nonce } = before.instagram.createOAuthState(USER);
    setKeys(KEY_OTHER, KEY_YT);
    const after = await loadModules();
    expect(after.instagram.verifyOAuthState(state, nonce, USER)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('keeps the two platforms states non-interchangeable under real keys', async () => {
    const { generic, instagram } = await loadModules();
    const youtube = generic.createOAuthState(USER);
    const insta = instagram.createOAuthState(USER);
    expect(instagram.verifyOAuthState(youtube.state, youtube.nonce, USER)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(generic.verifyOAuthState(insta.state, insta.nonce, USER)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('deriveSubkey', () => {
  it('defaults to the Instagram key', async () => {
    const { box } = await loadModules();
    expect(box.deriveSubkey('purpose', h.platform.INSTAGRAM)).toEqual(hmac(KEY_IG, 'purpose'));
  });

  it('uses the YouTube key when asked', async () => {
    const { box } = await loadModules();
    expect(box.deriveSubkey('purpose', h.platform.YOUTUBE)).toEqual(hmac(KEY_YT, 'purpose'));
  });

  it('gives each platform a different key for the same purpose', async () => {
    const { box } = await loadModules();
    expect(box.deriveSubkey('purpose', h.platform.INSTAGRAM)).not.toEqual(box.deriveSubkey('purpose', h.platform.YOUTUBE));
  });
});