import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Both state modules take their signing key from deriveSubkey(label). Mocking it with a
// fixed test master key isolates this suite from key management (covered in
// secret-box.test.ts) and lets the tests compute signatures independently.
const h = vi.hoisted(() => ({ master: Buffer.alloc(32, 9) }));

vi.mock('@/lib/crypto/secret-box', async () => {
  const { createHmac: hmac } = await import('node:crypto');
  return {
    deriveSubkey: (info: string): Buffer => hmac('sha256', h.master).update(info).digest(),
  };
});

interface StateModule {
  createOAuthState: (clerkUserId: string) => { state: string; nonce: string };
  verifyOAuthState: (
    state: string | null,
    cookieNonce: string | undefined,
    clerkUserId: string,
  ) => { ok: true } | { ok: false; reason: string };
  OAUTH_NONCE_COOKIE: string;
  OAUTH_COOKIE_PATH: string;
}

interface ModuleCase {
  name: string;
  load: () => Promise<StateModule>;
  label: string;
  cookie: string;
  path: string;
}

const loadGeneric = (): Promise<StateModule> => import('@/lib/oauth/state');
const loadInstagram = (): Promise<StateModule> => import('@/lib/instagram/oauth-state');

// The signing labels are part of the format: changing one invalidates every in-flight state.
const MODULES: ModuleCase[] = [
  {
    name: 'generic (YouTube) state',
    load: loadGeneric,
    label: 'socialbucks:oauth-state:v1',
    cookie: 'oauth_nonce',
    path: '/api/auth',
  },
  {
    name: 'Instagram state',
    load: loadInstagram,
    label: 'socialbucks:instagram-oauth-state:v1',
    cookie: 'ig_oauth_nonce',
    path: '/api/auth/instagram',
  },
];

const TTL_MS = 10 * 60 * 1000;
const START = new Date('2026-03-01T12:00:00Z').getTime();
const USER = 'user_2abcDEF123';
const NONCE = 'test-nonce-value';

const signingKey = (label: string): Buffer => createHmac('sha256', h.master).update(label).digest();
const sign = (body: string, label: string, key: Buffer = signingKey(label)): string =>
  createHmac('sha256', key).update(body).digest('base64url');
const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const encodePayload = (payload: unknown): string => encode(JSON.stringify(payload));
const flipFirst = (s: string): string => (s.startsWith('A') ? 'B' : 'A') + s.slice(1);
const split = (state: string): { body: string; signature: string } => {
  const [body = '', signature = ''] = state.split('.');
  return { body, signature };
};

const INVALID_PAYLOADS = [
  { name: 'non-JSON text', body: encode('not json at all') },
  { name: 'a JSON string', body: encode('"just a string"') },
  { name: 'JSON null', body: encode('null') },
  { name: 'a JSON number', body: encode('123') },
  { name: 'an array', body: encodePayload([]) },
  { name: 'an empty object', body: encodePayload({}) },
  { name: 'a numeric user id', body: encodePayload({ u: 1, n: NONCE, t: 1 }) },
  { name: 'a numeric nonce', body: encodePayload({ u: USER, n: 2, t: 1 }) },
  { name: 'a string timestamp', body: encodePayload({ u: USER, n: NONCE, t: '1' }) },
  { name: 'a missing timestamp', body: encodePayload({ u: USER, n: NONCE }) },
];

afterEach(() => {
  vi.useRealTimers();
});

describe.each(MODULES)('$name', ({ load, label, cookie, path }) => {
  const signed = (body: string): string => `${body}.${sign(body, label)}`;

  it('exposes the expected cookie name and path', async () => {
    const mod = await load();
    expect(mod.OAUTH_NONCE_COOKIE).toBe(cookie);
    expect(mod.OAUTH_COOKIE_PATH).toBe(path);
  });

  it('mints a state whose payload carries the user, the nonce and the issue time', async () => {
    const mod = await load();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { state, nonce } = mod.createOAuthState(USER);
    const payload = JSON.parse(Buffer.from(split(state).body, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(payload).toEqual({ u: USER, n: nonce, t: START });
  });

  it('mints a fresh 32-byte nonce and a different state every time', async () => {
    const mod = await load();
    const a = mod.createOAuthState(USER);
    const b = mod.createOAuthState(USER);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
  });

  it('signs the body with HMAC-SHA256 under the key derived from its label', async () => {
    const mod = await load();
    const { body, signature } = split(mod.createOAuthState(USER).state);
    expect(signature).toBe(sign(body, label));
  });

  it('accepts a state minted independently with node:crypto', async () => {
    const mod = await load();
    const body = encodePayload({ u: USER, n: NONCE, t: Date.now() });
    expect(mod.verifyOAuthState(signed(body), NONCE, USER)).toEqual({ ok: true });
  });

  it('accepts a valid state for the right user and nonce', async () => {
    const mod = await load();
    const { state, nonce } = mod.createOAuthState(USER);
    expect(mod.verifyOAuthState(state, nonce, USER)).toEqual({ ok: true });
  });

  it('rejects a state presented by a different user', async () => {
    const mod = await load();
    const { state, nonce } = mod.createOAuthState(USER);
    expect(mod.verifyOAuthState(state, nonce, 'user_someone_else')).toEqual({ ok: false, reason: 'user_mismatch' });
  });

  it('rejects a state whose nonce does not match the cookie', async () => {
    const mod = await load();
    const { state } = mod.createOAuthState(USER);
    expect(mod.verifyOAuthState(state, 'another-nonce', USER)).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it.each([
    { when: '1 ms before the TTL', offset: -1, expected: { ok: true } },
    { when: 'exactly the TTL', offset: 0, expected: { ok: true } },
    { when: '1 ms after the TTL', offset: 1, expected: { ok: false, reason: 'expired' } },
  ])('handles a state checked $when', async ({ offset, expected }) => {
    const mod = await load();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { state, nonce } = mod.createOAuthState(USER);
    vi.setSystemTime(START + TTL_MS + offset);
    expect(mod.verifyOAuthState(state, nonce, USER)).toEqual(expected);
  });

  it('reports expiry before nonce or user problems', async () => {
    const mod = await load();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { state } = mod.createOAuthState(USER);
    vi.setSystemTime(START + TTL_MS + 1);
    expect(mod.verifyOAuthState(state, 'wrong-nonce', 'wrong-user')).toEqual({ ok: false, reason: 'expired' });
  });

  it('reports a nonce mismatch before a user mismatch', async () => {
    const mod = await load();
    const { state } = mod.createOAuthState(USER);
    expect(mod.verifyOAuthState(state, 'wrong-nonce', 'wrong-user')).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it.each([
    { name: 'undefined', nonce: undefined },
    { name: 'an empty string', nonce: '' },
  ])('rejects a missing cookie nonce ($name) as malformed', async ({ nonce }) => {
    const mod = await load();
    const { state } = mod.createOAuthState(USER);
    expect(mod.verifyOAuthState(state, nonce, USER)).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    { name: 'null', state: null },
    { name: 'an empty string', state: '' },
  ])('rejects a missing state ($name) as malformed', async ({ state }) => {
    const mod = await load();
    expect(mod.verifyOAuthState(state, NONCE, USER)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a tampered body', async () => {
    const mod = await load();
    const { state, nonce } = mod.createOAuthState(USER);
    const { body, signature } = split(state);
    expect(mod.verifyOAuthState(`${flipFirst(body)}.${signature}`, nonce, USER)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered signature', async () => {
    const mod = await load();
    const { state, nonce } = mod.createOAuthState(USER);
    const { body, signature } = split(state);
    expect(mod.verifyOAuthState(`${body}.${flipFirst(signature)}`, nonce, USER)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a forged payload that reuses the original signature', async () => {
    const mod = await load();
    const { state, nonce } = mod.createOAuthState(USER);
    const forgedBody = encodePayload({ u: 'attacker', n: nonce, t: Date.now() });
    expect(mod.verifyOAuthState(`${forgedBody}.${split(state).signature}`, nonce, 'attacker')).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a state signed with a different key', async () => {
    const mod = await load();
    const body = encodePayload({ u: USER, n: NONCE, t: Date.now() });
    const forged = `${body}.${sign(body, label, Buffer.alloc(32, 1))}`;
    expect(mod.verifyOAuthState(forged, NONCE, USER)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    { name: 'no dot at all', state: 'nodotseparator' },
    { name: 'three parts', state: 'a.b.c' },
  ])('rejects a state with $name as malformed', async ({ state }) => {
    const mod = await load();
    expect(mod.verifyOAuthState(state, NONCE, USER)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an oversized state without throwing', async () => {
    const mod = await load();
    const huge = 'A'.repeat(200_000);
    expect(() => mod.verifyOAuthState(`${huge}.${huge}`, NONCE, USER)).not.toThrow();
    expect(mod.verifyOAuthState(`${huge}.${huge}`, NONCE, USER)).toMatchObject({ ok: false });
  });

  it.each(INVALID_PAYLOADS)('rejects a validly signed payload that is $name as malformed', async ({ body }) => {
    const mod = await load();
    expect(mod.verifyOAuthState(signed(body), NONCE, USER)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('the two state modules are isolated from each other', () => {
  it('rejects an Instagram state in the generic module', async () => {
    const instagram = await loadInstagram();
    const generic = await loadGeneric();
    const { state, nonce } = instagram.createOAuthState(USER);
    expect(generic.verifyOAuthState(state, nonce, USER)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a generic state in the Instagram module', async () => {
    const instagram = await loadInstagram();
    const generic = await loadGeneric();
    const { state, nonce } = generic.createOAuthState(USER);
    expect(instagram.verifyOAuthState(state, nonce, USER)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('uses different nonce cookies, so one platform nonce cannot stand in for the other', async () => {
    const instagram = await loadInstagram();
    const generic = await loadGeneric();
    expect(generic.OAUTH_NONCE_COOKIE).not.toBe(instagram.OAUTH_NONCE_COOKIE);
  });
});