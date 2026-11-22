// apps/web/src/lib/youtube/creator-link.ts
//
// Thin wrapper over the generic social account linkage module.
// Maps YouTube-specific types to the generic DB layer,
// and ensures token encryption happens here so plaintext tokens
// never travel deeper into the app.
//
// Mirrors lib/instagram/creator-link.ts for Instagram.

import { SocialPlatform } from '@repo/database';
import { decryptToken, encryptToken } from '@/lib/crypto/secret-box';
import {
  findActiveTokenCiphertexts,
  linkSocialAccount,
  unlinkSocialAccount,
  disconnectSocialPlatformForUser,
  purgeSocialData,
  type LinkResult,
} from '@/lib/social/creator-link';
import {
  revokeGoogleToken,
  type RevokeOutcome,
} from '@/lib/youtube/revoke-token';
import {
  REQUIRED_SCOPES,
} from './constants';
import type {
  YouTubeTokens,
  YouTubeChannel,
} from './oauth';

export async function linkYouTubeAccount(params: {
  clerkUserId: string;
  channel: YouTubeChannel;
  tokens: YouTubeTokens;
}): Promise<LinkResult> {
  const { clerkUserId, channel, tokens } = params;

  // Encrypt outside the transaction — the generic layer handles
  // the insert, not us.
  // refreshToken may be null if Google didn't return one; store null,
  // which the generic layer treats as "no token."
  let ciphertext: string | null = null;
  if (tokens.refreshToken) {
    ciphertext = encryptToken(
      tokens.refreshToken,
      SocialPlatform.YOUTUBE,
    );
  }

  return linkSocialAccount({
    clerkUserId,
    platform: SocialPlatform.YOUTUBE,
    externalId: channel.id,
    handle: channel.customUrl,
    displayName: channel.title,
    tokenCiphertext: ciphertext,
    tokenExpiresAt: null, // refresh tokens don't expire
    scopes: [...REQUIRED_SCOPES],
  });
}

export async function unlinkYouTubeAccount(
  channelId: string,
): Promise<'unlinked' | 'not_found'> {
  return unlinkSocialAccount(
    SocialPlatform.YOUTUBE,
    channelId,
  );
}

/**
 * Decrypts a stored refresh token and best-effort revokes it at Google. The
 * plaintext exists only inside this function's scope. A decrypt failure is its
 * own outcome: the token cannot be revoked, but the row is still cleared.
 */
async function revokeStoredToken(
  ciphertext: string,
): Promise<RevokeOutcome | 'undecryptable'> {
  let token: string;
  try {
    token = decryptToken(ciphertext, SocialPlatform.YOUTUBE);
  } catch {
    return 'undecryptable';
  }

  try {
    return await revokeGoogleToken(token);
  } catch {
    // revokeGoogleToken never throws by contract; this is defensive only.
    return 'failed';
  }
}

/**
 * Revokes the creator's active YouTube grant at Google, then clears the local
 * row. Ordering matters: revoke first, clear second. If the database update
 * fails after a successful revoke the stored token is merely dead and a retry
 * is harmless, whereas clearing first could leave a live Google grant we can
 * no longer revoke.
 *
 * A revoke outcome of any kind never prevents the local disconnect, and the
 * plaintext token is never returned or logged.
 */
export async function disconnectYouTubeForUser(
  clerkUserId: string,
): Promise<'disconnected' | 'not_connected'> {
  // If this throws, the disconnect fails like it does today and the user can
  // retry; we must not clear a token we could not first try to revoke.
  const ciphertexts = await findActiveTokenCiphertexts(
    clerkUserId,
    SocialPlatform.YOUTUBE,
  );

  const counts = {
    revoked: 0,
    rejected: 0,
    unavailable: 0,
    failed: 0,
    undecryptable: 0,
  };

  for (const ciphertext of ciphertexts) {
    const outcome = await revokeStoredToken(ciphertext);
    counts[outcome] += 1;
  }

  if (ciphertexts.length > 0) {
    console.info('[youtube] token revoke attempted', counts);
  }

  return disconnectSocialPlatformForUser(
    clerkUserId,
    SocialPlatform.YOUTUBE,
  );
}

export async function purgeYouTubeData(
  channelId: string,
): Promise<'purged' | 'not_found'> {
  return purgeSocialData(SocialPlatform.YOUTUBE, channelId);
}