// apps/web/src/lib/oauth/state.ts
//
// CSRF protection for the OAuth connect flow, plus a defence against
// account-grafting.
//
// Shared between Instagram and YouTube. See instagram/oauth-state.ts
// for the security analysis.
//
// The plain CSRF case is the usual double-submit: a random nonce goes
// into an httpOnly cookie and into the `state` parameter, and the
// callback requires them to match.
//
// The subtler attack this also closes: an attacker starts the flow
// with their own social account, then gets a signed-in victim to
// load the resulting callback URL. Without binding, the victim's
// Creator row gets the attacker's account attached — and from then
// on the attacker's reel views drive the victim's payouts. Binding
// the initiating Clerk user into the signed state and re-checking it
// at the callback means a state minted for one account is useless
// in another's session.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { deriveSubkey } from '@/lib/crypto/secret-box';

/** Cookie is scoped to the callback path — it has no business being sent anywhere else. */
export const OAUTH_NONCE_COOKIE = 'oauth_nonce';
export const OAUTH_COOKIE_PATH = '/api/auth';

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_KEY_INFO = 'socialbucks:oauth-state:v1';

interface StatePayload {
  /** Clerk user id that initiated the flow. */
  u: string;
  /** Nonce mirrored in the cookie. */
  n: string;
  /** Issued-at, epoch ms. */
  t: number;
}

function signBody(body: string): string {
  return createHmac('sha256', deriveSubkey(STATE_KEY_INFO))
    .update(body)
    .digest('base64url');
}

/** timingSafeEqual throws on length mismatch, which would itself leak. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createOAuthState(clerkUserId: string): {
  state: string;
  nonce: string;
} {
  const nonce = randomBytes(32).toString('base64url');
  const payload: StatePayload = { u: clerkUserId, n: nonce, t: Date.now() };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  return { state: `${body}.${signBody(body)}`, nonce };
}

export type StateRejection =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'nonce_mismatch'
  | 'user_mismatch';

export function verifyOAuthState(
  state: string | null,
  cookieNonce: string | undefined,
  clerkUserId: string,
): { ok: true } | { ok: false; reason: StateRejection } {
  if (!state || !cookieNonce) {
    return { ok: false, reason: 'malformed' };
  }

  const parts = state.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const [body, signature] = parts;

  // Signature first: never parse a payload we haven't authenticated.
  if (!constantTimeEquals(signature, signBody(body))) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: StatePayload;
  try {
    const decoded = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as unknown;

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof (decoded as StatePayload).u !== 'string' ||
      typeof (decoded as StatePayload).n !== 'string' ||
      typeof (decoded as StatePayload).t !== 'number'
    ) {
      return { ok: false, reason: 'malformed' };
    }

    payload = decoded as StatePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (Date.now() - payload.t > STATE_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }

  if (!constantTimeEquals(payload.n, cookieNonce)) {
    return { ok: false, reason: 'nonce_mismatch' };
  }

  if (!constantTimeEquals(payload.u, clerkUserId)) {
    return { ok: false, reason: 'user_mismatch' };
  }

  return { ok: true };
}