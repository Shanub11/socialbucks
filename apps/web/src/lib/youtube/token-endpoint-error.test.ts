// apps/web/src/lib/youtube/token-endpoint-error.test.ts
//
// Unit tests for the Google token-endpoint error mapping. They pin the safe
// provider code and the preserved HTTP status, and prove that no part of
// error_description can reach the thrown message or providerCode.

import { describe, expect, it } from 'vitest';

import { OAuthHttpError } from '@/lib/oauth/request';
import {
  UNKNOWN_PROVIDER_CODE,
  assertGoogleTokenResponseOk,
  extractGoogleErrorCode,
} from './token-endpoint-error';

const SENTINEL_DESCRIPTION = 'SENTINEL_DESCRIPTION';

function captureError(fn: () => void): OAuthHttpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof OAuthHttpError) return error;
    throw error;
  }
  throw new Error('expected OAuthHttpError');
}

describe('extractGoogleErrorCode', () => {
  it.each(['invalid_grant', 'invalid_client', 'invalid_request'])(
    'returns the machine code %s as is',
    (code) => {
      expect(extractGoogleErrorCode({ error: code })).toBe(code);
    },
  );

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string body', 'invalid_grant'],
    ['an array body', ['invalid_grant']],
    ['an empty object', {}],
    ['a numeric error', { error: 5 }],
    ['an object error', { error: { code: 400 } }],
    ['free text with spaces', { error: 'Has Spaces' }],
    ['uppercase text', { error: 'UPPER' }],
    ['an over-long value', { error: 'a'.repeat(65) }],
    ['an empty string', { error: '' }],
    [
      'free text carrying an email address',
      { error: 'Token for user@example.com expired' },
    ],
  ])('returns unknown for %s', (_label, body) => {
    expect(extractGoogleErrorCode(body)).toBe(UNKNOWN_PROVIDER_CODE);
  });
});

describe('assertGoogleTokenResponseOk', () => {
  it('returns normally for a 200 token response without an error envelope', () => {
    expect(() =>
      assertGoogleTokenResponseOk(
        {
          status: 200,
          body: {
            access_token: 'test-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
        'YouTube token exchange',
      ),
    ).not.toThrow();
  });

  it('maps 400 invalid_grant and never echoes error_description', () => {
    const error = captureError(() =>
      assertGoogleTokenResponseOk(
        {
          status: 400,
          body: {
            error: 'invalid_grant',
            error_description: SENTINEL_DESCRIPTION,
          },
        },
        'YouTube token exchange',
      ),
    );

    expect(error.status).toBe(400);
    expect(error.providerCode).toBe('invalid_grant');
    expect(error.message).toBe(
      'YouTube token exchange rejected the request (code invalid_grant)',
    );
    expect(error.message).not.toContain(SENTINEL_DESCRIPTION);
    expect(error.providerCode).not.toContain(SENTINEL_DESCRIPTION);
  });

  it('maps 401 invalid_client', () => {
    const error = captureError(() =>
      assertGoogleTokenResponseOk(
        { status: 401, body: { error: 'invalid_client' } },
        'YouTube token refresh',
      ),
    );

    expect(error.status).toBe(401);
    expect(error.providerCode).toBe('invalid_client');
  });

  it('uses unknown and preserves status 500 when the body has no code', () => {
    const error = captureError(() =>
      assertGoogleTokenResponseOk(
        { status: 500, body: {} },
        'YouTube token exchange',
      ),
    );

    expect(error.status).toBe(500);
    expect(error.providerCode).toBe(UNKNOWN_PROVIDER_CODE);
  });

  it('never rewrites a 404 status', () => {
    const error = captureError(() =>
      assertGoogleTokenResponseOk(
        { status: 404, body: {} },
        'YouTube token refresh',
      ),
    );

    expect(error.status).toBe(404);
  });

  it('treats an HTTP 200 error envelope as a failure with status 200', () => {
    const error = captureError(() =>
      assertGoogleTokenResponseOk(
        { status: 200, body: { error: 'invalid_request' } },
        'YouTube token exchange',
      ),
    );

    expect(error.status).toBe(200);
    expect(error.providerCode).toBe('invalid_request');
    expect(error.message).toBe(
      'YouTube token exchange rejected the request (code invalid_request)',
    );
  });

  it('formats the message from the label and the safe code', () => {
    const error = captureError(() =>
      assertGoogleTokenResponseOk(
        { status: 400, body: { error: 'invalid_scope' } },
        'YouTube token refresh',
      ),
    );

    expect(error.message).toBe(
      'YouTube token refresh rejected the request (code invalid_scope)',
    );
  });
});
