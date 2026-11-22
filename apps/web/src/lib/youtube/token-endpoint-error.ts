// apps/web/src/lib/youtube/token-endpoint-error.ts
//
// Google's token endpoint reports OAuth failures in a flat envelope,
// {"error":"invalid_grant","error_description":"..."}, and can return that
// envelope even with HTTP 200. The shared requestJson helper discards the body
// of a non-2xx response, so the token functions use requestJsonWithHeaders and
// check the body here.
//
// Only Google's machine-readable `error` code is propagated. error_description
// can echo request parameters (including the authorization code or refresh
// token), so no provider text reaches a thrown message, providerCode or log.
//
// The real HTTP status is preserved in OAuthHttpError: settlement treats 404
// as HELD_NO_DATA and analytics retries on OAuthHttpError, so rewriting a
// status here would silently change both behaviours.

import { OAuthHttpError } from '@/lib/oauth/request';

export const UNKNOWN_PROVIDER_CODE = 'unknown';

/** Google's machine codes are lowercase snake_case, e.g. invalid_grant. */
const PROVIDER_CODE_PATTERN = /^[a-z][a-z_]{0,63}$/;

/**
 * Returns Google's machine-readable error code when the body carries one.
 * Anything else -- a non-object, a non-string, free text, mixed case or an
 * over-long value -- collapses to a single safe placeholder, so provider text
 * can never leak into a message or log.
 */
export function extractGoogleErrorCode(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return UNKNOWN_PROVIDER_CODE;
  }

  const value = (body as Record<string, unknown>).error;
  if (typeof value !== 'string' || !PROVIDER_CODE_PATTERN.test(value)) {
    return UNKNOWN_PROVIDER_CODE;
  }
  return value;
}

/**
 * Throws OAuthHttpError unless the token endpoint returned a 2xx response
 * without an `error` envelope. `label` names the operation for the message;
 * `result.status` is passed through unchanged.
 */
export function assertGoogleTokenResponseOk(
  result: { status: number; body: unknown },
  label: string,
): void {
  const failedByStatus = result.status < 200 || result.status >= 300;
  const failedByBody =
    typeof result.body === 'object' &&
    result.body !== null &&
    'error' in result.body;

  if (!failedByStatus && !failedByBody) {
    return;
  }

  const code = extractGoogleErrorCode(result.body);
  throw new OAuthHttpError(`${label} rejected the request (code ${code})`, {
    status: result.status,
    providerCode: code,
  });
}
