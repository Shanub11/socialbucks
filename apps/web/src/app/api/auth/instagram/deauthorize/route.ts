// TARGET PATH: apps/web/src/app/api/auth/instagram/deauthorize/route.ts
//
// Meta calls this when a creator removes our app from their Instagram
// account. It is unauthenticated from our side — the signed_request HMAC is
// the authentication — and it must be idempotent, because Meta retries.
//
// Deliberately returns 200 for an unknown user id. A 404 here would both
// leak whether a given Instagram account is on socialbucks and cause Meta to
// retry a callback that will never succeed.

import { NextResponse } from 'next/server';

import { unlinkInstagramAccount } from '@/lib/instagram/creator-link';
import {
  readSignedRequestField,
  verifySignedRequest,
} from '@/lib/instagram/signed-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const signedRequest = await readSignedRequestField(request);
  const verified = verifySignedRequest(signedRequest);

  if (!verified.ok) {
    console.warn('[instagram] rejected deauthorize callback', {
      reason: verified.reason,
    });
    return NextResponse.json({ error: 'Invalid signed request' }, { status: 400 });
  }

  try {
    const outcome = await unlinkInstagramAccount(verified.payload.userId);

    console.info('[instagram] deauthorize processed', {
      instagramUserId: verified.payload.userId,
      outcome,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    // A 500 makes Meta retry, which is what we want for a transient
    // database problem — this is the one case worth failing loudly.
    console.error('[instagram] deauthorize handler failed', {
      instagramUserId: verified.payload.userId,
      message: error instanceof Error ? error.message : undefined,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
