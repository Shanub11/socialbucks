// TARGET PATH: apps/web/src/lib/instagram/signed-request.ts
//
// Verifies Meta's `signed_request` payload, which is how the deauthorize
// and data-deletion callbacks identify a user. These endpoints are
// unauthenticated from our side — anyone on the internet can POST to them —
// so signature verification *is* the authentication. Without it, an
// attacker could unlink or wipe any creator's Instagram connection by
// guessing an Instagram user id.
//
// Format is `<base64url signature>.<base64url payload>`, and the HMAC is
// computed over the *encoded* payload string, not the decoded JSON.

import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/env';

export interface SignedRequestPayload {
  /** Instagram-scoped user id of the person who deauthorized / requested deletion. */
  userId: string;
  issuedAt: number | undefined;
}

export type SignedRequestRejection =
  | 'missing'
  | 'malformed'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'no_user_id';

/**
 * Meta's docs are ambiguous about whether an Instagram-Login app signs
 * these callbacks with the Instagram app secret or the top-level Meta app
 * secret, and it is not worth guessing wrong in production: a wrong guess
 * silently rejects every real callback. We accept either configured
 * secret. Both are ours, so this widens nothing an attacker can reach.
 *
 * Once you've logged which one actually verifies, narrow this to that one
 * and drop the other from env.
 */
function candidateSecrets(): string[] {
  return [env.INSTAGRAM_APP_SECRET, env.META_APP_SECRET].filter(
    (secret): secret is string => typeof secret === 'string' && secret.length > 0,
  );
}

function matchesAnySecret(encodedPayload: string, signature: Buffer): boolean {
  let verified = false;

  // Loop over every candidate rather than short-circuiting, so total work
  // doesn't depend on which secret matched.
  for (const secret of candidateSecrets()) {
    const expected = createHmac('sha256', secret)
      .update(encodedPayload)
      .digest();

    if (
      expected.length === signature.length &&
      timingSafeEqual(expected, signature)
    ) {
      verified = true;
    }
  }

  return verified;
}

export function verifySignedRequest(
  signedRequest: string | null | undefined,
):
  | { ok: true; payload: SignedRequestPayload }
  | { ok: false; reason: SignedRequestRejection } {
  if (!signedRequest) {
    return { ok: false, reason: 'missing' };
  }

  const parts = signedRequest.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const [encodedSignature, encodedPayload] = parts;

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as unknown;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof decoded !== 'object' || decoded === null) {
    return { ok: false, reason: 'malformed' };
  }

  const payload = decoded as Record<string, unknown>;

  // Reject before verifying: an attacker must not be able to select a
  // weaker algorithm, and historically `algorithm: "none"` is exactly how
  // this class of format gets broken.
  if (
    typeof payload.algorithm !== 'string' ||
    payload.algorithm.toUpperCase() !== 'HMAC-SHA256'
  ) {
    return { ok: false, reason: 'unsupported_algorithm' };
  }

  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length === 0 || !matchesAnySecret(encodedPayload, signature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const rawUserId = payload.user_id;
  if (typeof rawUserId !== 'string' && typeof rawUserId !== 'number') {
    return { ok: false, reason: 'no_user_id' };
  }

  return {
    ok: true,
    payload: {
      userId: String(rawUserId),
      issuedAt:
        typeof payload.issued_at === 'number' ? payload.issued_at : undefined,
    },
  };
}

/**
 * Both callbacks arrive as `application/x-www-form-urlencoded` with a
 * single `signed_request` field.
 */
export async function readSignedRequestField(
  request: Request,
): Promise<string | null> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    // Not documented, but cheap to tolerate rather than 400 on.
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const value = body.signed_request;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  try {
    const form = await request.formData();
    const value = form.get('signed_request');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}
