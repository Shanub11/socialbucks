// TARGET PATH: apps/web/src/app/api/auth/instagram/start/route.ts
//
// Entry point for the Instagram connect flow. Link a creator here rather
// than at Meta's "Embed URL": going through our own route is what lets us
// mint a signed, session-bound `state` value, which is the only defence
// against someone else's Instagram account being grafted onto a signed-in
// creator's row.
//
// nodejs runtime is required (transitively reads the app secret via
// oauth.ts and derives a key via node:crypto).

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { APP_ORIGIN } from '@/lib/instagram/constants';
import {
  OAUTH_COOKIE_PATH,
  OAUTH_NONCE_COOKIE,
  createOAuthState,
} from '@/lib/instagram/oauth-state';
import { buildAuthorizeUrl } from '@/lib/instagram/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_TTL_SECONDS = 10 * 60;

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    const signIn = new URL('/sign-in', APP_ORIGIN);
    signIn.searchParams.set('redirect_url', '/api/auth/instagram/start');
    return NextResponse.redirect(signIn);
  }

  const { state, nonce } = createOAuthState(userId);
  const response = NextResponse.redirect(buildAuthorizeUrl(state));

  response.cookies.set({
    name: OAUTH_NONCE_COOKIE,
    value: nonce,
    httpOnly: true,
    // Always on: Meta refuses non-HTTPS redirect URIs, so the whole flow is
    // HTTPS by definition. If this cookie ever goes missing in dev, the
    // cause is browsing the app over http://localhost instead of the ngrok
    // origin — not this flag.
    secure: true,
    // Must be 'lax', not 'strict'. The callback arrives as a top-level
    // cross-site GET navigation from instagram.com; 'strict' would withhold
    // the cookie and every connection attempt would fail state validation.
    sameSite: 'lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: STATE_TTL_SECONDS,
  });

  return response;
}
