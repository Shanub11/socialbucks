// apps/web/src/lib/youtube/get-access-token.ts
//
// Decrypts a stored YouTube refresh-token ciphertext and exchanges it for
// a fresh, short-lived access token. Shared by the settlement adapter and
// the campaign-approval route — do not duplicate this decrypt+refresh
// sequence a third time anywhere else.

import { SocialPlatform } from '@repo/database';
import { decryptToken } from '@/lib/crypto/secret-box';
import { refreshAccessToken } from '@/lib/youtube/oauth';

/**
 * Decrypts a stored YouTube refresh-token ciphertext and exchanges it for
 * a fresh, short-lived access token.
 *
 * @param ciphertext - The encrypted refresh token from SocialAccount.tokenCiphertext
 * @returns Promise resolving to a fresh access token (1-hour TTL)
 * @throws If decryption fails or the refresh token is invalid/revoked
 */
export async function getYoutubeAccessToken(ciphertext: string): Promise<string> {
  const refreshToken = decryptToken(ciphertext, SocialPlatform.YOUTUBE);
  const { accessToken } = await refreshAccessToken(refreshToken);
  return accessToken;
}
