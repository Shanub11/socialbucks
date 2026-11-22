// apps/web/src/app/api/auth/youtube/disconnect/route.ts
//
// User-initiated disconnect from our own UI. Revokes the active
// YouTube account for the signed-in Clerk user.
//
// POST, not GET, and Origin-checked. A missing or mismatched Origin is
// rejected with a 403. On success, responds with a 303 redirect to
// CONNECT_RETURN_PATH with ?youtube=disconnected and burns the nonce cookie.
//
// This is a soft-delete (sets revokedAt), not a hard delete: the row stays as
// an audit-trail entry for payout disputes. The stored refresh token is
// best-effort revoked at Google first, then its ciphertext is cleared; a
// failed or unavailable revoke never blocks the disconnect.

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { CONNECT_RETURN_PATH, getAppOrigin } from '@/lib/youtube/constants';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_COOKIE_PATH,
} from '@/lib/oauth/state';
import { disconnectYouTubeForUser } from '@/lib/youtube/creator-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const { userId } = await auth();
  const appOrigin = getAppOrigin();

  if (!userId) {
    const signIn = new URL('/sign-in', appOrigin);
    signIn.searchParams.set('redirect_url', CONNECT_RETURN_PATH);
    return NextResponse.redirect(signIn, 303);
  }

  // Browsers always send Origin on a cross-origin or same-origin POST, so
  // a missing header is itself grounds for rejection here.
  const origin = request.headers.get('origin');
  if (origin !== appOrigin) {
    console.warn('[youtube] rejected disconnect with bad origin', {
      clerkUserId: userId,
    });
    return NextResponse.json({ error: 'Bad origin' }, { status: 403 });
  }

  const outcome = await disconnectYouTubeForUser(userId);

  console.info('[youtube] disconnect requested', {
    clerkUserId: userId,
    outcome,
  });

  const target = new URL(CONNECT_RETURN_PATH, appOrigin);
  target.searchParams.set('youtube', 'disconnected');

  // 303, not the default 307: a 307 preserves the method and the browser
  // would re-POST to the return path, which is not a POST route.
  const response = NextResponse.redirect(target, 303);

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
