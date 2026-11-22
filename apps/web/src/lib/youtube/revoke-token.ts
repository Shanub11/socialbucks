// apps/web/src/lib/youtube/revoke-token.ts
//
// Revokes a Google OAuth grant. Disconnect must still clear the locally stored
// refresh token when Google refuses or is unreachable, so this module
// classifies outcomes instead of throwing: the caller counts them and always
// completes the local disconnect.
//
// The token travels only in the form body. The URL carries no query, redirects
// are refused so a 3xx cannot forward the credential to another host, and the
// response body is never read: Google returns an empty 200 for success, and a
// body from any endpoint can echo request parameters.
//
// No logging lives here. The caller logs outcome counts, never token material.

import { YOUTUBE_REVOKE_URL } from '@/lib/youtube/constants';

export type RevokeOutcome = 'revoked' | 'rejected' | 'unavailable' | 'failed';

export const REVOKE_TIMEOUT_MS = 5_000;

/**
 * Statuses only. 429 and 5xx mean Google could not answer right now; every
 * other non-2xx (including 400 for an already-invalid token) is a definitive
 * rejection. The body is deliberately not consulted.
 */
function classifyStatus(status: number): RevokeOutcome {
  if (status >= 200 && status < 300) return 'revoked';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'rejected';
}

/**
 * Never throws. The plaintext token exists only in this call's scope and is
 * never included in a returned value, a log or an error message.
 */
export async function revokeGoogleToken(token: string): Promise<RevokeOutcome> {
  if (token.length === 0) return 'rejected';

  try {
    const response = await fetch(YOUTUBE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });

    const outcome = classifyStatus(response.status);

    try {
      // Release the connection without reading the body. Best effort only:
      // the status already decided the outcome.
      await response.body?.cancel();
    } catch {
      // Ignored on purpose; a body we cannot cancel must not change the
      // classified outcome.
    }

    return outcome;
  } catch {
    return 'failed';
  }
}
