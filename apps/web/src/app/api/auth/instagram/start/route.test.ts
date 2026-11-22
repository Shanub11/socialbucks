// apps/web/src/app/api/auth/instagram/start/route.test.ts
//
// Start-route behaviour for Instagram: signed-in success, signed-out redirect,
// and the fail-closed 303 when state minting or URL building fails. A config
// error must never surface as a raw 500 or leak provider/config text.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/instagram/oauth-state', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/instagram/oauth-state')>();
  return { ...actual, createOAuthState: vi.fn() };
});

vi.mock('@/lib/instagram/constants', () => ({
  APP_ORIGIN: 'https://app.test',
  CONNECT_RETURN_PATH: '/creator/accounts',
}));

vi.mock('@/lib/instagram/oauth', () => ({
  buildAuthorizeUrl: vi.fn(),
}));

import { auth } from '@clerk/nextjs/server';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import { CONNECT_RETURN_PATH } from '@/lib/instagram/constants';
import {
  OAUTH_COOKIE_PATH,
  OAUTH_NONCE_COOKIE,
  createOAuthState,
} from '@/lib/instagram/oauth-state';
import { buildAuthorizeUrl } from '@/lib/instagram/oauth';
import { GET } from './route';

const TEST_ORIGIN = 'https://app.test';
const USER_ID = 'user_test_123';
const STATE = 'test-state';
const NONCE = 'test-nonce';
const AUTHORIZE_URL =
  'https://www.instagram.com/oauth/authorize?client_id=test-client';
const SENTINEL = 'SENTINEL_CONFIG_SECRET';

const consoleError = vi
  .spyOn(console, 'error')
  .mockImplementation(() => undefined);

class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * A real zod ZodError, produced the way production produces one. Under zod
 * 4.6.7 `new z.ZodError([...])` is a legacy object that is not an Error, while
 * a safeParse failure is; the route's `instanceof Error` name check therefore
 * sees the latter.
 */
function sentinelZodError(message: string): z.ZodError {
  const parsed = z
    .string()
    .refine(() => false, { message })
    .safeParse('test-value');
  if (parsed.success) {
    throw new Error('expected a Zod parse failure');
  }
  return parsed.error;
}

function expectConnectFailure(response: Response): void {
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(
    `${CONNECT_RETURN_PATH}?instagram=error&reason=unexpected`,
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('set-cookie')).toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ userId: USER_ID } as never);
  vi.mocked(createOAuthState).mockReturnValue({ state: STATE, nonce: NONCE });
  vi.mocked(buildAuthorizeUrl).mockReturnValue(AUTHORIZE_URL);
});

describe('GET /api/auth/instagram/start', () => {
  it('no session: redirects to /sign-in and mints no state', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);

    const response = await GET();

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.origin).toBe(TEST_ORIGIN);
    expect(url.pathname).toBe('/sign-in');
    expect(url.searchParams.get('redirect_url')).toBe(
      '/api/auth/instagram/start',
    );
    expect(createOAuthState).not.toHaveBeenCalled();
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it('success: redirects to the authorize URL and sets the nonce cookie', async () => {
    const response = (await GET()) as NextResponse;

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(AUTHORIZE_URL);
    expect(createOAuthState).toHaveBeenCalledWith(USER_ID);
    expect(buildAuthorizeUrl).toHaveBeenCalledWith(STATE);

    const cookie = response.cookies.get(OAUTH_NONCE_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe(NONCE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe(OAUTH_COOKIE_PATH);
    expect(cookie?.maxAge).toBe(600);
  });

  it('state minting SecretBoxError: 303 failure without the sentinel', async () => {
    vi.mocked(createOAuthState).mockImplementation(() => {
      throw new SecretBoxError(`state key derivation failed: ${SENTINEL}`);
    });

    const response = await GET();

    expectConnectFailure(response);
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[instagram] connect start failed',
      {
        clerkUserId: USER_ID,
        name: 'SecretBoxError',
      },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(SENTINEL);
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(
      SENTINEL,
    );
  });

  it('authorize URL ZodError: 303 failure without the sentinel', async () => {
    vi.mocked(buildAuthorizeUrl).mockImplementation(() => {
      throw sentinelZodError(`invalid redirect URI: ${SENTINEL}`);
    });

    const response = await GET();

    expectConnectFailure(response);
    expect(consoleError).toHaveBeenCalledWith(
      '[instagram] connect start failed',
      {
        clerkUserId: USER_ID,
        name: 'ZodError',
      },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(SENTINEL);
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(
      SENTINEL,
    );
  });

  it('missing config Error: 303 failure with name Error', async () => {
    vi.mocked(buildAuthorizeUrl).mockImplementation(() => {
      throw new Error('Instagram OAuth is not configured');
    });

    const response = await GET();

    expectConnectFailure(response);
    expect(consoleError).toHaveBeenCalledWith(
      '[instagram] connect start failed',
      {
        clerkUserId: USER_ID,
        name: 'Error',
      },
    );
  });

  it('a thrown non-Error: name unknown and the string is not logged', async () => {
    vi.mocked(buildAuthorizeUrl).mockImplementation(() => {
      throw SENTINEL;
    });

    const response = await GET();

    expectConnectFailure(response);
    expect(consoleError).toHaveBeenCalledWith(
      '[instagram] connect start failed',
      {
        clerkUserId: USER_ID,
        name: 'unknown',
      },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(SENTINEL);
  });
});
