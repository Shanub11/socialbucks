// apps/web/src/app/api/auth/youtube/callback/route.test.ts
//
// Route-level behaviour of the YouTube callback: which coarse failure code the
// creator sees, what is logged, and that the nonce cookie is always burned.
// Everything external is mocked; no network, database or real secrets.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/auth/ensure-user', () => ({
  ensureUserProvisioned: vi.fn(),
}));

vi.mock('@/lib/youtube/creator-link', () => ({
  linkYouTubeAccount: vi.fn(),
}));

vi.mock('@/lib/oauth/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/oauth/state')>();
  return { ...actual, verifyOAuthState: vi.fn() };
});

vi.mock('@/lib/youtube/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/constants')>();
  return { ...actual, getAppOrigin: () => 'https://app.example.test' };
});

vi.mock('@/lib/youtube/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/youtube/oauth')>();
  return {
    ...actual,
    exchangeCodeForToken: vi.fn(),
    fetchChannel: vi.fn(),
  };
});

import { auth } from '@clerk/nextjs/server';
import { NextRequest, type NextResponse } from 'next/server';

import { ensureUserProvisioned } from '@/lib/auth/ensure-user';
import { OAuthHttpError } from '@/lib/oauth/request';
import {
  OAUTH_COOKIE_PATH,
  OAUTH_NONCE_COOKIE,
  verifyOAuthState,
} from '@/lib/oauth/state';
import { linkYouTubeAccount } from '@/lib/youtube/creator-link';
import {
  CONNECT_RETURN_PATH,
  REQUIRED_SCOPES,
} from '@/lib/youtube/constants';
import { exchangeCodeForToken, fetchChannel } from '@/lib/youtube/oauth';
import { GET } from './route';

const TEST_ORIGIN = 'https://app.example.test';
const USER_ID = 'user_test_123';
const SENTINEL_SECRET = 'SENTINEL_SECRET_CHANNEL_FAILURE';

const TOKENS = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  expiresIn: 3600,
  expiresAt: new Date('2026-04-01T00:00:00Z'),
  grantedScopes: [...REQUIRED_SCOPES],
};

const CHANNEL = {
  id: 'UC_test_channel',
  title: 'Test Channel',
  customUrl: '@test_channel',
  duration: null,
  subscriberCount: null,
  videoCount: null,
};

const consoleError = vi
  .spyOn(console, 'error')
  .mockImplementation(() => undefined);
vi.spyOn(console, 'warn').mockImplementation(() => undefined);
vi.spyOn(console, 'info').mockImplementation(() => undefined);

function makeRequest(): NextRequest {
  const url = new URL('/api/auth/youtube/callback', TEST_ORIGIN);
  url.searchParams.set('code', 'test-authorization-code');
  url.searchParams.set('state', 'test-state');

  return new NextRequest(url, {
    headers: { cookie: `${OAUTH_NONCE_COOKIE}=test-nonce` },
  });
}

function expectHomeRedirect(
  response: NextResponse,
  expected: { youtube: string; reason?: string },
): void {
  const location = response.headers.get('location');
  expect(location).not.toBeNull();
  const url = new URL(location!);
  expect(url.origin).toBe(TEST_ORIGIN);
  expect(url.pathname).toBe(CONNECT_RETURN_PATH);
  expect(url.searchParams.get('youtube')).toBe(expected.youtube);
  expect(url.searchParams.get('reason')).toBe(expected.reason ?? null);

  const nonceCookie = response.cookies.get(OAUTH_NONCE_COOKIE);
  expect(nonceCookie).toBeDefined();
  expect(nonceCookie?.value).toBe('');
  expect(nonceCookie?.maxAge).toBe(0);
  expect(nonceCookie?.path).toBe(OAUTH_COOKIE_PATH);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ userId: USER_ID } as never);
  vi.mocked(ensureUserProvisioned).mockResolvedValue({
    ok: true,
    userId: 'user_row_test_123',
    created: false,
  });
  vi.mocked(verifyOAuthState).mockReturnValue({ ok: true });
});

describe('GET /api/auth/youtube/callback', () => {
  it('no session: redirects to /sign-in and makes no provider call', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);

    const response = await GET(makeRequest());

    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.origin).toBe(TEST_ORIGIN);
    expect(url.pathname).toBe('/sign-in');
    expect(url.searchParams.get('redirect_url')).toBe(CONNECT_RETURN_PATH);
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it('success: links the account and redirects with youtube=connected', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue(TOKENS);
    vi.mocked(fetchChannel).mockResolvedValue(CHANNEL);
    vi.mocked(linkYouTubeAccount).mockResolvedValue({
      ok: true,
      creatorId: 'creator_test_123',
      accountId: 'account_test_123',
    });

    const response = await GET(makeRequest());

    expectHomeRedirect(response, { youtube: 'connected' });
    expect(linkYouTubeAccount).toHaveBeenCalledTimes(1);
    expect(linkYouTubeAccount).toHaveBeenCalledWith({
      clerkUserId: USER_ID,
      channel: CHANNEL,
      tokens: TOKENS,
    });
  });

  it('token exchange OAuthHttpError: youtube_error with the step and provider code', async () => {
    vi.mocked(exchangeCodeForToken).mockRejectedValue(
      new OAuthHttpError(
        'YouTube token exchange rejected the request (code invalid_grant)',
        { status: 400, providerCode: 'invalid_grant' },
      ),
    );

    const response = await GET(makeRequest());

    expectHomeRedirect(response, { youtube: 'error', reason: 'youtube_error' });
    expect(consoleError).toHaveBeenCalledWith(
      '[youtube] OAuth provider request failed',
      {
        clerkUserId: USER_ID,
        name: 'OAuthHttpError',
        step: 'token_exchange',
        status: 400,
        providerCode: 'invalid_grant',
      },
    );
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it('token exchange timeout: youtube_error with the step and no status', async () => {
    vi.mocked(exchangeCodeForToken).mockRejectedValue(
      new OAuthHttpError('Provider request timed out'),
    );

    const response = await GET(makeRequest());

    expectHomeRedirect(response, { youtube: 'error', reason: 'youtube_error' });
    expect(consoleError).toHaveBeenCalledWith(
      '[youtube] OAuth provider request failed',
      {
        clerkUserId: USER_ID,
        name: 'OAuthHttpError',
        step: 'token_exchange',
        status: undefined,
        providerCode: undefined,
      },
    );
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it('channel fetch OAuthHttpError: youtube_error with step channel_fetch', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue(TOKENS);
    vi.mocked(fetchChannel).mockRejectedValue(
      new OAuthHttpError('Provider returned 403', { status: 403 }),
    );

    const response = await GET(makeRequest());

    expectHomeRedirect(response, { youtube: 'error', reason: 'youtube_error' });
    expect(consoleError).toHaveBeenCalledWith(
      '[youtube] OAuth provider request failed',
      {
        clerkUserId: USER_ID,
        name: 'OAuthHttpError',
        step: 'channel_fetch',
        status: 403,
        providerCode: undefined,
      },
    );
    expect(linkYouTubeAccount).not.toHaveBeenCalled();
  });

  it('channel fetch plain Error: unexpected, and its message is never logged', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue(TOKENS);
    vi.mocked(fetchChannel).mockRejectedValue(
      new Error(`channel fetch failed for ${SENTINEL_SECRET}`),
    );

    const response = await GET(makeRequest());

    expectHomeRedirect(response, { youtube: 'error', reason: 'unexpected' });
    expect(consoleError).toHaveBeenCalledWith(
      '[youtube] unexpected callback failure',
      {
        clerkUserId: USER_ID,
        name: 'Error',
        step: 'channel_fetch',
      },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      SENTINEL_SECRET,
    );
  });

  it('link failure: unexpected with step link', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue(TOKENS);
    vi.mocked(fetchChannel).mockResolvedValue(CHANNEL);
    vi.mocked(linkYouTubeAccount).mockRejectedValue(new Error('link failed'));

    const response = await GET(makeRequest());

    expectHomeRedirect(response, { youtube: 'error', reason: 'unexpected' });
    expect(consoleError).toHaveBeenCalledWith(
      '[youtube] unexpected callback failure',
      {
        clerkUserId: USER_ID,
        name: 'Error',
        step: 'link',
      },
    );
  });

  it('missing scopes: reason=missing_scope and no channel fetch', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue({
      ...TOKENS,
      grantedScopes: [REQUIRED_SCOPES[0]],
    });

    const response = await GET(makeRequest());

    expectHomeRedirect(response, { youtube: 'error', reason: 'missing_scope' });
    expect(fetchChannel).not.toHaveBeenCalled();
    expect(linkYouTubeAccount).not.toHaveBeenCalled();
  });

  it('null channel: reason=youtube_error and no link', async () => {
    vi.mocked(exchangeCodeForToken).mockResolvedValue(TOKENS);
    vi.mocked(fetchChannel).mockResolvedValue(null);

    const response = await GET(makeRequest());

    expectHomeRedirect(response, { youtube: 'error', reason: 'youtube_error' });
    expect(linkYouTubeAccount).not.toHaveBeenCalled();
  });
});
