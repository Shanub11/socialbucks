// apps/web/src/app/api/auth/youtube/disconnect/route.ts
//
// User-initiated disconnect from our own UI. Revokes the active
// YouTube account for the signed-in Clerk user.
//
// This is a soft-delete (sets revokedAt), not a hard delete — the
// row stays as an audit-trail entry for payout disputes.

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { APP_ORIGIN } from '@/lib/youtube/constants';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_COOKIE_PATH,
} from '@/lib/oauth/state';
import { disconnectYouTubeForUser } from '@/lib/youtube/creator-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const { userId } = await auth();

  if (!userId) {
    const signIn = new URL('/sign-in', APP_ORIGIN);
    signIn.searchParams.set(
      'redirect_url',
      '/api/auth/youtube/disconnect',
    );
    return NextResponse.redirect(signIn);
  }

  const result = await disconnectYouTubeForUser(userId);

  const response = NextResponse.json({
    ok: true,
    status: result,
  });

  // Burn the nonce cookie — the state is now invalid and should not
  // be reused.
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