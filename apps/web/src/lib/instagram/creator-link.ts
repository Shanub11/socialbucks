// apps/web/src/lib/instagram/creator-link.ts
//
// Thin wrapper over the generic social account linkage module.
// Maps Instagram-specific types (InstagramProfile) to the generic DB layer,
// and ensures token encryption happens here so plaintext tokens never travel
// deeper into the app.

import { SocialPlatform } from '@repo/database';
import { encryptToken } from '@/lib/crypto/secret-box';
import {
  linkSocialAccount,
  unlinkSocialAccount,
  disconnectSocialPlatformForUser,
  purgeSocialData,
  type LinkResult,
} from '@/lib/social/creator-link';
import type { InstagramProfile, LongLivedToken } from '@/lib/instagram/oauth';
import { REQUIRED_SCOPES } from '@/lib/instagram/constants';

export async function linkInstagramAccount(params: {
  clerkUserId: string;
  profile: InstagramProfile;
  token: LongLivedToken;
}): Promise<LinkResult> {
  const { clerkUserId, profile, token } = params;

  // Encrypt outside the transaction
  const ciphertext = encryptToken(token.accessToken, SocialPlatform.INSTAGRAM);
  
  // InstagramAccountType is dropped in the new generic schema,
  // we just write to SocialAccount.
  return linkSocialAccount({
    clerkUserId,
    platform: SocialPlatform.INSTAGRAM,
    externalId: profile.instagramUserId,
    handle: profile.username,
    displayName: null,
    tokenCiphertext: ciphertext,
    tokenExpiresAt: token.expiresAt,
    scopes: [...REQUIRED_SCOPES], // Or real scopes if known
  });
}

export async function unlinkInstagramAccount(
  instagramUserId: string,
): Promise<'unlinked' | 'not_found'> {
  return unlinkSocialAccount(SocialPlatform.INSTAGRAM, instagramUserId);
}

export async function disconnectInstagramForUser(
  clerkUserId: string,
): Promise<'disconnected' | 'not_connected'> {
  return disconnectSocialPlatformForUser(clerkUserId, SocialPlatform.INSTAGRAM);
}

export async function purgeInstagramData(
  instagramUserId: string,
): Promise<'purged' | 'not_found'> {
  return purgeSocialData(SocialPlatform.INSTAGRAM, instagramUserId);
}

