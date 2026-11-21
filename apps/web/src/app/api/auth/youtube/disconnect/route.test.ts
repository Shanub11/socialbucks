import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/youtube/creator-link', () => ({
  disconnectYouTubeForUser: vi.fn(),
}));

vi.mock('@/lib/youtube/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/constants')>();
  return { ...actual, getAppOrigin: () => 'https://app.example.test' };
});

import { auth } from '@clerk/nextjs/server';
import { disconnectYouTubeForUser } from '@/lib/youtube/creator-link';
import { CONNECT_RETURN_PATH } from '@/lib/youtube/constants';
import { OAUTH_COOKIE_PATH, OAUTH_NONCE_COOKIE } from '@/lib/oauth/state';
import { POST } from './route';

const TEST_ORIGIN = 'https://app.example.test';

describe('POST /api/auth/youtube/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no session: 303 to /sign-in with redirect_url=/creator/accounts, disconnect NOT called', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);

    const request = new Request(`${TEST_ORIGIN}/api/auth/youtube/disconnect`, {
      method: 'POST',
      headers: {
        origin: TEST_ORIGIN,
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(303);
    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.origin).toBe(TEST_ORIGIN);
    expect(url.pathname).toBe('/sign-in');
    expect(url.searchParams.get('redirect_url')).toBe('/creator/accounts');
    expect(disconnectYouTubeForUser).not.toHaveBeenCalled();
  });

  it('missing Origin: 403, disconnect NOT called', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_test_123' } as never);

    const request = new Request(`${TEST_ORIGIN}/api/auth/youtube/disconnect`, {
      method: 'POST',
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json).toEqual({ error: 'Bad origin' });
    expect(disconnectYouTubeForUser).not.toHaveBeenCalled();
  });

  it('wrong Origin: 403, disconnect NOT called', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_test_123' } as never);

    const request = new Request(`${TEST_ORIGIN}/api/auth/youtube/disconnect`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example.com',
      },
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json).toEqual({ error: 'Bad origin' });
    expect(disconnectYouTubeForUser).not.toHaveBeenCalled();
  });

  it('correct Origin: disconnect called once with the Clerk userId, 303 to /creator/accounts?youtube=disconnected, nonce cookie cleared (maxAge 0)', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: 'user_test_123' } as never);
    vi.mocked(disconnectYouTubeForUser).mockResolvedValue('disconnected');

    const request = new Request(`${TEST_ORIGIN}/api/auth/youtube/disconnect`, {
      method: 'POST',
      headers: {
        origin: TEST_ORIGIN,
      },
    });

    const response = await POST(request);

    expect(disconnectYouTubeForUser).toHaveBeenCalledTimes(1);
    expect(disconnectYouTubeForUser).toHaveBeenCalledWith('user_test_123');

    expect(response.status).toBe(303);
    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.origin).toBe(TEST_ORIGIN);
    expect(url.pathname).toBe('/creator/accounts');
    expect(url.searchParams.get('youtube')).toBe('disconnected');

    const nonceCookie = response.cookies.get(OAUTH_NONCE_COOKIE);
    expect(nonceCookie).toBeDefined();
    expect(nonceCookie?.maxAge).toBe(0);
    expect(nonceCookie?.value).toBe('');
    expect(nonceCookie?.path).toBe(OAUTH_COOKIE_PATH);
    expect(nonceCookie?.httpOnly).toBe(true);
    expect(nonceCookie?.secure).toBe(true);
    expect(nonceCookie?.sameSite).toBe('lax');
  });

  it('CONNECT_RETURN_PATH from lib/youtube/constants equals /creator/accounts', () => {
    expect(CONNECT_RETURN_PATH).toBe('/creator/accounts');
  });
});
