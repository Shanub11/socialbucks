// TARGET PATH: apps/web/src/lib/instagram/creator-link.ts
//
// All database writes for the Instagram connection live here rather than in
// the route handlers, so the routes stay thin and this logic is testable
// without a Request object.
//
// Token encryption happens here too — the plaintext token never travels
// further into the app than this module.

import { prisma, InstagramAccountType } from '@repo/database';

import { encryptSecret } from '@/lib/crypto/secret-box';
import { TOKEN_ENCRYPTION_CONTEXT } from '@/lib/instagram/constants';
import type { InstagramProfile, LongLivedToken } from '@/lib/instagram/oauth';

/**
 * Meta returns MEDIA_CREATOR for creator accounts; our enum calls that
 * CREATOR. PERSONAL exists in the enum but this API can never return it —
 * personal accounts cannot complete Instagram business login at all — so an
 * unrecognized value is stored as null rather than silently coerced.
 */
export function mapAccountType(
  raw: string | undefined,
): InstagramAccountType | null {
  switch (raw?.toUpperCase()) {
    case 'BUSINESS':
      return InstagramAccountType.BUSINESS;
    case 'CREATOR':
    case 'MEDIA_CREATOR':
      return InstagramAccountType.CREATOR;
    default:
      return null;
  }
}

export type LinkFailure = 'user_not_provisioned' | 'account_already_linked';

export type LinkResult =
  | { ok: true; creatorId: string }
  | { ok: false; reason: LinkFailure };

export async function linkInstagramAccount(params: {
  clerkUserId: string;
  profile: InstagramProfile;
  token: LongLivedToken;
}): Promise<LinkResult> {
  const { clerkUserId, profile, token } = params;

  // Encrypt outside the transaction — no reason to hold a database
  // connection open across a CPU-bound operation.
  const ciphertext = encryptSecret(token.accessToken, TOKEN_ENCRYPTION_CONTEXT);
  const accountType = mapAccountType(profile.rawAccountType);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { clerkId: clerkUserId },
      select: { id: true, deletedAt: true },
    });

    // The Clerk webhook provisions this row. If it's absent the webhook
    // hasn't landed yet (or ngrok is pointing somewhere stale), which is a
    // different problem from an OAuth failure and worth reporting as such.
    if (!user || user.deletedAt) {
      return { ok: false as const, reason: 'user_not_provisioned' as const };
    }

    // instagramUserId is globally unique: one Instagram account cannot fund
    // two creators. Checking explicitly turns a P2002 constraint violation
    // into an error message we can actually show someone.
    const existing = await tx.creator.findUnique({
      where: { instagramUserId: profile.instagramUserId },
      select: { id: true, userId: true },
    });

    if (existing && existing.userId !== user.id) {
      return { ok: false as const, reason: 'account_already_linked' as const };
    }

    const creator = await tx.creator.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        instagramUserId: profile.instagramUserId,
        instagramUsername: profile.username,
        instagramAccountType: accountType,
        instagramConnectedAt: now,
        instagramTokenCiphertext: ciphertext,
        instagramTokenExpiresAt: token.expiresAt,
      },
      update: {
        instagramUserId: profile.instagramUserId,
        instagramUsername: profile.username,
        instagramAccountType: accountType,
        instagramConnectedAt: now,
        instagramTokenCiphertext: ciphertext,
        instagramTokenExpiresAt: token.expiresAt,
        // Reconnecting an account that was previously removed should
        // revive the row, not leave it soft-deleted.
        deletedAt: null,
      },
      select: { id: true },
    });

    return { ok: true as const, creatorId: creator.id };
  });
}

/**
 * Deauthorize callback. Clears the linkage and destroys the stored token,
 * but keeps the Creator row: it may be attached to live
 * CampaignCreatorSlot records, and those have onDelete: Restrict.
 *
 * Setting instagramUserId to null (rather than leaving it) frees the unique
 * index so the same Instagram account can be connected again later —
 * Postgres permits many NULLs in a unique column.
 */
export async function unlinkInstagramAccount(
  instagramUserId: string,
): Promise<'unlinked' | 'not_found'> {
  const result = await prisma.creator.updateMany({
    where: { instagramUserId },
    data: {
      instagramUserId: null,
      instagramUsername: null,
      instagramAccountType: null,
      instagramConnectedAt: null,
      instagramTokenCiphertext: null,
      instagramTokenExpiresAt: null,
    },
  });

  return result.count > 0 ? 'unlinked' : 'not_found';
}

/**
 * User-initiated disconnect from our own UI. Same effect as the deauthorize
 * callback, but keyed on the Clerk user rather than the Instagram user id,
 * so it works even if the stored instagramUserId is somehow stale.
 *
 * Note this does not revoke the token at Meta's end — only Instagram can do
 * that, from the creator's own app settings. The token is destroyed here, so
 * we can no longer use it, which is the part we control.
 */
export async function disconnectInstagramForUser(
  clerkUserId: string,
): Promise<'disconnected' | 'not_connected'> {
  const result = await prisma.creator.updateMany({
    where: {
      user: { clerkId: clerkUserId },
      deletedAt: null,
      instagramUserId: { not: null },
    },
    data: {
      instagramUserId: null,
      instagramUsername: null,
      instagramAccountType: null,
      instagramConnectedAt: null,
      instagramTokenCiphertext: null,
      instagramTokenExpiresAt: null,
    },
  });

  return result.count > 0 ? 'disconnected' : 'not_connected';
}

/**
 * Data-deletion callback. Same token destruction as unlink, plus a
 * soft-delete of the Creator so it stops appearing anywhere in the product.
 *
 * A hard delete is not an option while slots reference the row, and it
 * would also destroy the financial record of past payouts. If you need
 * genuine erasure semantics for a compliance regime, that's a scheduled job
 * that settles or voids outstanding slots first — not this handler.
 */
export async function purgeInstagramData(
  instagramUserId: string,
): Promise<'purged' | 'not_found'> {
  const result = await prisma.creator.updateMany({
    where: { instagramUserId },
    data: {
      instagramUserId: null,
      instagramUsername: null,
      instagramAccountType: null,
      instagramConnectedAt: null,
      instagramTokenCiphertext: null,
      instagramTokenExpiresAt: null,
      deletedAt: new Date(),
    },
  });

  return result.count > 0 ? 'purged' : 'not_found';
}
