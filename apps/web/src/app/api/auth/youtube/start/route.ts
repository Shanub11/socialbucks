// apps/web/src/app/api/auth/youtube/start/route.ts
//
// Entry point for the YouTube connect flow. Link a creator here
// rather than at the Google consent screen: going through our own
// route is what lets us mint a signed, session-bound `state` value,
// which is the only defence against someone else's Google
// account being grafted onto a signed-in creator's row.
//
// Node-only (reads the client secret via oauth.ts, uses node:crypto
// for state signing).

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { APP_ORIGIN } from '@/lib/youtube/constants';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_COOKIE_PATH,
  createOAuthState,
} from '@/lib/oauth/state';
import { buildAuthorizeUrl } from '@/lib/youtube/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_TTL_SECONDS = 10 * 60;

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    const signIn = new URL('/sign-in', APP_ORIGIN);
    signIn.searchParams.set('redirect_url', '/api/auth/youtube/start');
    return NextResponse.redirect(signIn);
  }

  const { state, nonce } = createOAuthState(userId);
  const response = NextResponse.redirect(buildAuthorizeUrl(state));

  response.cookies.set({
    name: OAUTH_NONCE_COOKIE,
    value: nonce,
    httpOnly: true,
    // YouTube, like Meta, refuses non-HTTPS redirect URIs, so the
    // whole flow is HTTPS by definition. If this cookie ever goes
    // missing in dev, the cause is browsing the app over http://
    // localhost instead of the ngrok origin — not this flag.
    secure: true,
    // Must be 'lax', not 'strict'. The callback arrives as a
    // top-level cross-site GET navigation from accounts.google.com;
    // 'strict' would withhold the cookie and every connection
    // attempt would fail state validation.
    sameSite: 'lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: STATE_TTL_SECONDS,
  });

  return response;
}