// apps/web/src/lib/youtube/oauth-token-errors.test.ts
//
// Behaviour of exchangeCodeForToken and refreshAccessToken when Google's token
// endpoint fails. fetch is stubbed and env-parts is mocked, so this suite uses
// no network and no real credentials.
//
// Every failure also asserts that the console never saw the client secret, the
// authorization code, the refresh token or Google's error_description.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env-parts', () => ({
  youtubeOAuth: {
    clientId: 'dummy-client-id',
    clientSecret: 'dummy-client-secret',
    redirectUri: 'https://app.example.test/api/auth/youtube/callback',
  },
}));

import { OAuthHttpError } from '@/lib/oauth/request';
import { YOUTUBE_TOKEN_URL } from '@/lib/youtube/constants';
import { exchangeCodeForToken, refreshAccessToken } from './oauth';

const CLIENT_SECRET = 'dummy-client-secret';
const AUTH_CODE = 'test-authorization-code';
const REFRESH_TOKEN = 'test-refresh-token';
const SENTINEL_DESCRIPTION = 'SENTINEL_DESCRIPTION';

const fetchMock = vi.fn();

const consoleSpies = (['error', 'warn', 'info', 'log'] as const).map((method) =>
  vi.spyOn(console, method).mockImplementation(() => undefined),
);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function captureError(
  fn: () => Promise<unknown>,
): Promise<OAuthHttpError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof OAuthHttpError) return error;
    throw error;
  }
  throw new Error('expected OAuthHttpError');
}

function loggedText(): string {
  return JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));
}

function expectNoSecretsLogged(...secrets: string[]): void {
  const text = loggedText();
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

function firstFetchCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  return { url: call[0], init: call[1] ?? {} };
}

function requestParams(): URLSearchParams {
  const { init } = firstFetchCall();
  expect(init.body).toBeInstanceOf(URLSearchParams);
  return init.body as URLSearchParams;
}

const TOKEN_SUCCESS_BODY = {
  access_token: 'test-access-token',
  refresh_token: REFRESH_TOKEN,
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'scope-a scope-b',
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('exchangeCodeForToken', () => {
  it('returns tokens and posts the authorization-code grant exactly once', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, TOKEN_SUCCESS_BODY));

    const before = Date.now();
    const tokens = await exchangeCodeForToken(AUTH_CODE);

    expect(tokens.accessToken).toBe('test-access-token');
    expect(tokens.refreshToken).toBe(REFRESH_TOKEN);
    expect(tokens.expiresIn).toBe(3600);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(before);
    expect(tokens.grantedScopes).toEqual(['scope-a', 'scope-b']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = firstFetchCall();
    expect(url).toBe(YOUTUBE_TOKEN_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const params = requestParams();
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe(AUTH_CODE);
    expect(params.get('client_id')).toBe('dummy-client-id');
    expect(params.get('client_secret')).toBe(CLIENT_SECRET);
  });

  it('maps 400 invalid_grant without leaking the description or the code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: 'invalid_grant',
        error_description: SENTINEL_DESCRIPTION,
      }),
    );

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBe(400);
    expect(error.providerCode).toBe('invalid_grant');
    expect(error.message).toBe(
      'YouTube token exchange rejected the request (code invalid_grant)',
    );
    expect(error.message).not.toContain(SENTINEL_DESCRIPTION);
    expect(error.message).not.toContain(AUTH_CODE);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });

  it('maps 401 invalid_client', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: 'invalid_client' }),
    );

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBe(401);
    expect(error.providerCode).toBe('invalid_client');
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });

  it('maps 400 invalid_request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'invalid_request' }),
    );

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBe(400);
    expect(error.providerCode).toBe('invalid_request');
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });

  it('uses unknown when the provider error is free text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'Token for user@example.com expired' }),
    );

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBe(400);
    expect(error.providerCode).toBe('unknown');
    expect(error.message).not.toContain('user@example.com');
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });

  it('preserves 503 for an HTML error body with no provider code', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Service Unavailable</html>', { status: 503 }),
    );

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBe(503);
    expect(error.providerCode).toBeUndefined();
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });

  it('rejects an HTTP 200 response that carries an error envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { error: 'invalid_grant' }),
    );

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBe(200);
    expect(error.providerCode).toBe('invalid_grant');
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });

  it('maps a timeout to OAuthHttpError without a status', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeout);

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBeUndefined();
    expect(error.providerCode).toBeUndefined();
    expect(error.message).toBe('Provider request timed out');
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });

  it('maps a connect failure to OAuthHttpError without a status', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBeUndefined();
    expect(error.providerCode).toBeUndefined();
    expect(error.message).toBe('Provider request failed to connect');
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });

  it('never rewrites a 404 token response status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));

    const error = await captureError(() => exchangeCodeForToken(AUTH_CODE));

    expect(error.status).toBe(404);
    expectNoSecretsLogged(CLIENT_SECRET, AUTH_CODE, SENTINEL_DESCRIPTION);
  });
});

describe('refreshAccessToken', () => {
  it('returns tokens with a null refresh token and posts the refresh grant once', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, TOKEN_SUCCESS_BODY));

    const before = Date.now();
    const tokens = await refreshAccessToken(REFRESH_TOKEN);

    expect(tokens.accessToken).toBe('test-access-token');
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.expiresIn).toBe(3600);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(before);
    expect(tokens.grantedScopes).toEqual(['scope-a', 'scope-b']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = firstFetchCall();
    expect(url).toBe(YOUTUBE_TOKEN_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const params = requestParams();
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(params.get('client_secret')).toBe(CLIENT_SECRET);
  });

  it('maps 400 invalid_grant without leaking the description or the refresh token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: 'invalid_grant',
        error_description: SENTINEL_DESCRIPTION,
      }),
    );

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBe(400);
    expect(error.providerCode).toBe('invalid_grant');
    expect(error.message).toBe(
      'YouTube token refresh rejected the request (code invalid_grant)',
    );
    expect(error.message).not.toContain(SENTINEL_DESCRIPTION);
    expect(error.message).not.toContain(REFRESH_TOKEN);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });

  it('maps 401 invalid_client', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: 'invalid_client' }),
    );

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBe(401);
    expect(error.providerCode).toBe('invalid_client');
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });

  it('maps 400 invalid_request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'invalid_request' }),
    );

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBe(400);
    expect(error.providerCode).toBe('invalid_request');
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });

  it('uses unknown when the provider error is free text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: 'Refresh token revoked by user' }),
    );

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBe(400);
    expect(error.providerCode).toBe('unknown');
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });

  it('preserves 503 for an HTML error body with no provider code', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Service Unavailable</html>', { status: 503 }),
    );

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBe(503);
    expect(error.providerCode).toBeUndefined();
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });

  it('rejects an HTTP 200 response that carries an error envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { error: 'invalid_grant' }),
    );

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBe(200);
    expect(error.providerCode).toBe('invalid_grant');
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });

  it('maps a timeout to OAuthHttpError without a status', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeout);

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBeUndefined();
    expect(error.providerCode).toBeUndefined();
    expect(error.message).toBe('Provider request timed out');
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });

  it('maps a connect failure to OAuthHttpError without a status', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBeUndefined();
    expect(error.providerCode).toBeUndefined();
    expect(error.message).toBe('Provider request failed to connect');
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });

  it('never rewrites a 404 token response status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));

    const error = await captureError(() => refreshAccessToken(REFRESH_TOKEN));

    expect(error.status).toBe(404);
    expectNoSecretsLogged(CLIENT_SECRET, REFRESH_TOKEN, SENTINEL_DESCRIPTION);
  });
});
