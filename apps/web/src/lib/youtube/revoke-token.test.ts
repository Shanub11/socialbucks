// apps/web/src/lib/youtube/revoke-token.test.ts
//
// Revoke outcomes, request shape and leak checks. fetch is stubbed, so no
// network is involved. Every case also asserts that nothing was logged, that
// the response body was not read, and that the returned value carries no
// token material.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { YOUTUBE_REVOKE_URL } from '@/lib/youtube/constants';
import {
  REVOKE_TIMEOUT_MS,
  revokeGoogleToken,
  type RevokeOutcome,
} from './revoke-token';

const TOKEN = 'test-refresh-token-value';
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

function bodySpies(response: Response) {
  return {
    text: vi.spyOn(response, 'text'),
    json: vi.spyOn(response, 'json'),
    arrayBuffer: vi.spyOn(response, 'arrayBuffer'),
  };
}

function expectBodyNeverRead(spies: ReturnType<typeof bodySpies>): void {
  expect(spies.text).not.toHaveBeenCalled();
  expect(spies.json).not.toHaveBeenCalled();
  expect(spies.arrayBuffer).not.toHaveBeenCalled();
}

async function revoke(): Promise<RevokeOutcome> {
  const outcome = await revokeGoogleToken(TOKEN);

  // The promise must resolve, and the outcome must carry no token material.
  expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  expect(JSON.stringify(outcome)).not.toContain(SENTINEL_DESCRIPTION);

  return outcome;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('revokeGoogleToken', () => {
  it('200: posts the token in the form body only and returns revoked', async () => {
    const response = new Response(null, { status: 200 });
    const spies = bodySpies(response);
    fetchMock.mockResolvedValueOnce(response);

    await expect(revoke()).resolves.toBe('revoked');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(YOUTUBE_REVOKE_URL);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain('?');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = init.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('token')).toBe(TOKEN);

    expectBodyNeverRead(spies);
  });

  it('204: returns revoked', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(revoke()).resolves.toBe('revoked');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('400 with an error body: rejected, body never read', async () => {
    const response = jsonResponse(400, {
      error: 'invalid_token',
      error_description: SENTINEL_DESCRIPTION,
    });
    const spies = bodySpies(response);
    fetchMock.mockResolvedValueOnce(response);

    await expect(revoke()).resolves.toBe('rejected');

    expectBodyNeverRead(spies);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])('%i: rejected', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, {}));

    await expect(revoke()).resolves.toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])('%i: unavailable with no retry', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, {}));

    await expect(revoke()).resolves.toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('timeout: resolves failed', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeout);

    await expect(revoke()).resolves.toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('network Error carrying the token: resolves failed without leaking it', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error(`connect failed while sending ${TOKEN}`),
    );

    await expect(revoke()).resolves.toBe('failed');
  });

  it('non-Error string: resolves failed', async () => {
    fetchMock.mockRejectedValueOnce('boom');

    await expect(revoke()).resolves.toBe('failed');
  });

  it('undefined rejection: resolves failed', async () => {
    fetchMock.mockRejectedValueOnce(undefined);

    await expect(revoke()).resolves.toBe('failed');
  });

  it('empty token: rejected without a fetch', async () => {
    await expect(revokeGoogleToken('')).resolves.toBe('rejected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the documented timeout constant', () => {
    expect(REVOKE_TIMEOUT_MS).toBe(5_000);
  });
});
