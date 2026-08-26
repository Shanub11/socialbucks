// TARGET PATH: apps/web/src/app/api/auth/instagram/disconnect/route.ts
//
// User-initiated disconnect, driven by a plain HTML form POST from the
// dashboard — no client JavaScript involved.
//
// POST, not GET, and Origin-checked. A GET would be triggerable by any
// <img src> on any page and would let a third-party site silently sever a
// creator's payout connection. Route handlers get none of the automatic CSRF
// protection Next applies to Server Actions, so the check is explicit here.

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { APP_ORIGIN, CONNECT_RETURN_PATH } from '@/lib/instagram/constants';
import { disconnectInstagramForUser } from '@/lib/instagram/creator-link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Browsers always send Origin on a cross-origin *or* same-origin POST, so
  // a missing header is itself grounds for rejection here.
  const origin = request.headers.get('origin');
  if (origin !== APP_ORIGIN) {
    console.warn('[instagram] rejected disconnect with bad origin', {
      clerkUserId: userId,
      origin,
    });
    return NextResponse.json({ error: 'Bad origin' }, { status: 403 });
  }

  const outcome = await disconnectInstagramForUser(userId);

  console.info('[instagram] disconnect requested', {
    clerkUserId: userId,
    outcome,
  });

  const target = new URL(CONNECT_RETURN_PATH, APP_ORIGIN);
  target.searchParams.set('instagram', 'disconnected');

  // 303, not the default 307: a 307 preserves the method and the browser
  // would re-POST to /dashboard, which is not a POST route.
  return NextResponse.redirect(target, 303);
}
