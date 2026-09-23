// apps/web/src/app/api/auth/youtube/callback/route.ts
//
// Where Google sends the creator back with an authorization code.
//
// Ordering matters and is deliberate:
//   1. require a session          — we must know whose account to link
//   2. validate state             — before spending the single-use code
//   3. exchange code -> tokens    — one hour of validity, single use
//   4. read the channel           — verify identity before persisting
//   5. encrypt and persist        — refresh token is encrypted
//
// Every exit path clears the nonce cookie, so a failed attempt can't
// have its state replayed.

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { ensureUserProvisioned } from '@/lib/auth/ensure-user';
import {
  APP_ORIGIN,
  CONNECT_RETURN_PATH,
  REQUIRED_SCOPES,
} from '@/lib/youtube/constants';
import { linkYouTubeAccount } from '@/lib/youtube/creator-link';
import {
  YouTubeOAuthError,
  exchangeCodeForToken,
  fetchChannel,
  findMissingScopes,
} from '@/lib/youtube/oauth';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_COOKIE_PATH,
  verifyOAuthState,
} from '@/lib/oauth/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stable, non-leaky codes for the UI to map to copy. Deliberately
 * coarse — the detail goes to the server log, not the query string.
 */
type FailureCode =
  | 'denied'
  | 'invalid_request'
  | 'security_check_failed'
  | 'missing_scope'
  | 'already_linked'
  | 'not_provisioned'
  | 'youtube_error'
  | 'unexpected';

function redirectHome(
  params: Record<string, string>,
): NextResponse {
  const target = new URL(CONNECT_RETURN_PATH, APP_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }

  const response = NextResponse.redirect(target);
  // Single-use: burn the nonce whether we succeeded or failed.
  response.cookies.set({
    name: OAUTH_NONCE_COOKIE,
    value: '',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: 0,
  });
  return response;
}

const fail = (code: FailureCode) =>
  redirectHome({ youtube: 'error', reason: code });

export async function GET(request: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    const signIn = new URL('/sign-in', APP_ORIGIN);
    signIn.searchParams.set('redirect_url', CONNECT_RETURN_PATH);
    return NextResponse.redirect(signIn);
  }

  const params = request.nextUrl.searchParams;

  // The creator pressed Cancel. Not an error worth logging.
  if (params.get('error')) {
    return fail('denied');
  }

  const rawCode = params.get('code');
  if (!rawCode) {
    return fail('invalid_request');
  }

  const stateCheck = verifyOAuthState(
    params.get('state'),
    request.cookies.get(OAUTH_NONCE_COOKIE)?.value,
    userId,
  );

  if (!stateCheck.ok) {
    // Worth a warning: benign causes (an expired tab, a stale
    // bookmark) look identical to an attack from here, so surface
    // it either way.
    console.warn('[youtube] rejected OAuth callback state', {
      reason: stateCheck.reason,
      clerkUserId: userId,
    });
    return fail('security_check_failed');
  }

  // Provision before spending the code, not after. If the row can't
  // be created there is no point burning a single-use
  // authorization code, and the creator gets a clean retry rather
  // than having to start over from a consumed code.
  const provisioned = await ensureUserProvisioned(userId);
  if (!provisioned.ok) {
    console.warn('[youtube] cannot link — no User row', {
      clerkUserId: userId,
      reason: provisioned.reason,
    });
    return fail('not_provisioned');
  }

  try {
    const tokens = await exchangeCodeForToken(rawCode);
    const missing = findMissingScopes(tokens.grantedScopes);

    if (missing.length > 0) {
      // The token is real but useless for our purposes — the creator
      // unticked a permission. Fail loudly now instead of discovering
      // it when a payout calculation silently has no view data.
      console.warn('[youtube] connection missing required scopes', {
        clerkUserId: userId,
        missing,
        required: REQUIRED_SCOPES,
      });
      return fail('missing_scope');
    }

    const channel = await fetchChannel(tokens.accessToken);
    if (!channel) {
      console.warn('[youtube] channel lookup failed', {
        clerkUserId: userId,
      });
      return fail('youtube_error');
    }

    const result = await linkYouTubeAccount({
      clerkUserId: userId,
      channel,
      tokens,
    });

    if (!result.ok) {
      console.warn('[youtube] could not link account', {
        clerkUserId: userId,
        reason: result.reason,
      });
      return fail(
        result.reason === 'account_already_linked'
          ? 'already_linked'
          : 'not_provisioned',
      );
    }

    console.info('[youtube] account connected', {
      creatorId: result.creatorId,
      channelId: channel.id,
      channelTitle: channel.title,
      refreshTokenStored: Boolean(tokens.refreshToken),
    });

    return redirectHome({ youtube: 'connected' });
  } catch (error) {
    if (error instanceof YouTubeOAuthError) {
      console.error('[youtube] OAuth exchange failed', {
        clerkUserId: userId,
        status: error.status,
        providerCode: error.providerCode,
        message: error.message,
      });
      return fail('youtube_error');
    }

    // Never let a raw error reach the browser — stack traces from
    // this handler can contain the code or token in a fetch URL.
    console.error('[youtube] unexpected callback failure', {
      clerkUserId: userId,
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : undefined,
    });
    return fail('unexpected');
  }
}