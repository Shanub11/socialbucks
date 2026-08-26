// TARGET PATH: apps/web/src/app/api/auth/instagram/data-deletion/route.ts
//
// Meta's data deletion request callback. Same authentication model as
// deauthorize (signed_request HMAC), but the response shape is prescribed:
// Meta requires JSON containing a `url` a person can visit to check the
// status of their request, and a `confirmation_code`.
//
// KNOWN GAP: the confirmation code is currently generated and logged but
// not persisted, because the schema has no table for deletion requests.
// That is acceptable in Development mode and NOT acceptable at App Review —
// Meta expects the status URL to actually resolve the code. The follow-up is
// a DataDeletionRequest model plus a page at DELETION_STATUS_PATH that looks
// it up. Flagged rather than faked.

import { randomBytes } from 'node:crypto';

import { NextResponse } from 'next/server';

import { APP_ORIGIN } from '@/lib/instagram/constants';
import { purgeInstagramData } from '@/lib/instagram/creator-link';
import {
  readSignedRequestField,
  verifySignedRequest,
} from '@/lib/instagram/signed-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DELETION_STATUS_PATH = '/data-deletion';

export async function POST(request: Request) {
  const signedRequest = await readSignedRequestField(request);
  const verified = verifySignedRequest(signedRequest);

  if (!verified.ok) {
    console.warn('[instagram] rejected data deletion callback', {
      reason: verified.reason,
    });
    return NextResponse.json({ error: 'Invalid signed request' }, { status: 400 });
  }

  const confirmationCode = randomBytes(12).toString('hex');

  try {
    const outcome = await purgeInstagramData(verified.payload.userId);

    console.info('[instagram] data deletion processed', {
      instagramUserId: verified.payload.userId,
      confirmationCode,
      outcome,
    });

    const statusUrl = new URL(DELETION_STATUS_PATH, APP_ORIGIN);
    statusUrl.searchParams.set('code', confirmationCode);

    // Field names are Meta's, not ours — do not rename them.
    return NextResponse.json({
      url: statusUrl.toString(),
      confirmation_code: confirmationCode,
    });
  } catch (error) {
    console.error('[instagram] data deletion handler failed', {
      instagramUserId: verified.payload.userId,
      confirmationCode,
      message: error instanceof Error ? error.message : undefined,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
