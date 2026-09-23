// apps/web/src/lib/youtube/creator-link.ts
//
// Thin wrapper over the generic social account linkage module.
// Maps YouTube-specific types to the generic DB layer,
// and ensures token encryption happens here so plaintext tokens
// never travel deeper into the app.
//
// Mirrors lib/instagram/creator-link.ts for Instagram.

import { SocialPlatform } from '@repo/database';
import { encryptToken } from '@/lib/crypto/secret-box';
import {
  linkSocialAccount,
  unlinkSocialAccount,
  disconnectSocialPlatformForUser,
  purgeSocialData,
  type LinkResult,
} from '@/lib/social/creator-link';
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

export async function disconnectYouTubeForUser(
  clerkUserId: string,
): Promise<'disconnected' | 'not_connected'> {
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