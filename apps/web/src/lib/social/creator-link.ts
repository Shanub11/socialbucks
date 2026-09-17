import { prisma, SocialPlatform } from '@repo/database';

export type LinkFailure = 'user_not_provisioned' | 'account_already_linked';

export type LinkResult =
  | { ok: true; creatorId: string; accountId: string }
  | { ok: false; reason: LinkFailure };

/**
 * Links a social account to a Creator.
 * Uses the normalized SocialAccount table.
 */
export async function linkSocialAccount(params: {
  clerkUserId: string;
  platform: SocialPlatform;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  tokenCiphertext: string;
  tokenExpiresAt: Date | null;
  scopes: string[];
}): Promise<LinkResult> {
  const {
    clerkUserId,
    platform,
    externalId,
    handle,
    displayName,
    tokenCiphertext,
    tokenExpiresAt,
    scopes,
  } = params;

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { clerkId: clerkUserId },
      select: { id: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      return { ok: false as const, reason: 'user_not_provisioned' as const };
    }

    // Check if this specific external social account is already linked
    // actively to ANY creator.
    const existing = await tx.socialAccount.findUnique({
      where: {
        platform_externalId: {
          platform,
          externalId,
        },
      },
      select: { id: true, creatorId: true },
    });

    // We must find the creator ID for the current user to compare.
    const creator = await tx.creator.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });

    if (existing && creator && existing.creatorId !== creator.id) {
      return { ok: false as const, reason: 'account_already_linked' as const };
    }

    // We still ensure the Creator row exists. If not, create it.
    const activeCreator = await tx.creator.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: { deletedAt: null },
      select: { id: true },
    });

    // For safety, let's revoke any existing active account for this creator/platform
    // that doesn't match the new externalId.
    await tx.socialAccount.updateMany({
      where: {
        creatorId: activeCreator.id,
        platform,
        revokedAt: null,
        externalId: { not: externalId },
      },
      data: {
        revokedAt: new Date(),
      },
    });

    const accountId = await ensureSocialAccount(tx, {
      creatorId: activeCreator.id,
      platform,
      externalId,
      handle,
      displayName,
      tokenCiphertext,
      tokenExpiresAt,
      scopes,
    });

    return { ok: true as const, creatorId: activeCreator.id, accountId };
  });
}

// Helper to upsert a SocialAccount correctly considering we don't have a true
// unique key without revokedAt constraint. We just find the latest one or create.
async function ensureSocialAccount(
  tx: any,
  data: {
    creatorId: string;
    platform: SocialPlatform;
    externalId: string;
    handle: string | null;
    displayName: string | null;
    tokenCiphertext: string;
    tokenExpiresAt: Date | null;
    scopes: string[];
  }
): Promise<string> {
  const existing = await tx.socialAccount.findFirst({
    where: {
      creatorId: data.creatorId,
      platform: data.platform,
      externalId: data.externalId,
    },
    orderBy: { connectedAt: 'desc' },
  });

  if (existing) {
    const updated = await tx.socialAccount.update({
      where: { id: existing.id },
      data: {
        handle: data.handle,
        displayName: data.displayName,
        tokenCiphertext: data.tokenCiphertext,
        tokenExpiresAt: data.tokenExpiresAt,
        scopes: data.scopes,
        revokedAt: null, // Reactivate if it was revoked
        lastVerifiedAt: null, // Reset verification
      },
    });
    return updated.id;
  }

  const created = await tx.socialAccount.create({
    data: {
      creatorId: data.creatorId,
      platform: data.platform,
      externalId: data.externalId,
      handle: data.handle,
      displayName: data.displayName,
      tokenCiphertext: data.tokenCiphertext,
      tokenExpiresAt: data.tokenExpiresAt,
      scopes: data.scopes,
    },
  });
  return created.id;
}

/**
 * Deauthorize callback. Sets revokedAt to now() for the specific external account.
 */
export async function unlinkSocialAccount(
  platform: SocialPlatform,
  externalId: string,
): Promise<'unlinked' | 'not_found'> {
  const result = await prisma.socialAccount.updateMany({
    where: { platform, externalId, revokedAt: null },
    data: {
      revokedAt: new Date(),
    },
  });

  return result.count > 0 ? 'unlinked' : 'not_found';
}

/**
 * User-initiated disconnect from our own UI. Revokes active accounts for the platform
 * linked to the given Clerk user.
 */
export async function disconnectSocialPlatformForUser(
  clerkUserId: string,
  platform: SocialPlatform,
): Promise<'disconnected' | 'not_connected'> {
  const result = await prisma.socialAccount.updateMany({
    where: {
      creator: { user: { clerkId: clerkUserId } },
      platform,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });

  return result.count > 0 ? 'disconnected' : 'not_connected';
}

/**
 * Data-deletion callback. Same as unlink, but also soft-deletes the Creator.
 */
export async function purgeSocialData(
  platform: SocialPlatform,
  externalId: string,
): Promise<'purged' | 'not_found'> {
  // Find the creator attached to this account
  const account = await prisma.socialAccount.findFirst({
    where: { platform, externalId, revokedAt: null },
    select: { creatorId: true },
  });

  if (!account) {
    return 'not_found';
  }

  await prisma.$transaction([
    prisma.socialAccount.updateMany({
      where: { platform, externalId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.creator.update({
      where: { id: account.creatorId },
      data: { deletedAt: new Date() },
    }),
  ]);

  return 'purged';
}
