// TARGET PATH: apps/web/src/lib/instagram/connection.ts
//
// Read-side of the Instagram connection: what the dashboard shows, and the
// live health check that proves the connection actually works.
//
// Two deliberately separate functions:
//
//   getInstagramConnection    — database only. Cheap, safe to call on every
//                               page render. Tells you what we *believe*.
//   runInstagramHealthCheck   — calls Meta. Never call this on page render;
//                               it costs a round trip and burns API quota.
//                               Tells you what is actually *true*.
//
// The distinction matters because every failure mode of this feature looks
// identical from the database alone: a revoked token, an expired token, a
// token missing the insights scope, and a perfectly healthy token all
// produce the same row.
//
// The decrypted token never leaves this module.

import { prisma } from '@repo/database';
import type { InstagramAccountType } from '@repo/database';

import { SecretBoxError, decryptSecret } from '@/lib/crypto/secret-box';
import {
  TOKEN_ENCRYPTION_CONTEXT,
  TOKEN_REFRESH_THRESHOLD_DAYS,
} from '@/lib/instagram/constants';
import { fetchMediaInsights, fetchRecentMedia } from '@/lib/instagram/media';
import { InstagramOAuthError, fetchInstagramProfile } from '@/lib/instagram/oauth';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface InstagramConnection {
  connected: boolean;
  creatorId: string | null;
  username: string | null;
  accountType: InstagramAccountType | null;
  connectedAt: Date | null;
  tokenExpiresAt: Date | null;
  /** Negative once expired. Null when nothing is stored. */
  daysUntilTokenExpiry: number | null;
  /** True inside the refresh window, or already past it. */
  needsRefresh: boolean;
}

const DISCONNECTED: InstagramConnection = {
  connected: false,
  creatorId: null,
  username: null,
  accountType: null,
  connectedAt: null,
  tokenExpiresAt: null,
  daysUntilTokenExpiry: null,
  needsRefresh: false,
};

export async function getInstagramConnection(
  clerkUserId: string,
): Promise<InstagramConnection> {
  const creator = await prisma.creator.findFirst({
    where: { user: { clerkId: clerkUserId }, deletedAt: null },
    select: {
      id: true,
      instagramUserId: true,
      instagramUsername: true,
      instagramAccountType: true,
      instagramConnectedAt: true,
      instagramTokenExpiresAt: true,
      instagramTokenCiphertext: true,
    },
  });

  if (!creator) return DISCONNECTED;

  // A Creator row can exist without a live connection — that is exactly the
  // state deauthorize leaves behind. The ciphertext is the real signal.
  const connected =
    creator.instagramUserId !== null &&
    creator.instagramTokenCiphertext !== null;

  const expiresAt = creator.instagramTokenExpiresAt;
  const daysUntilTokenExpiry = expiresAt
    ? Math.floor((expiresAt.getTime() - Date.now()) / MS_PER_DAY)
    : null;

  return {
    connected,
    creatorId: creator.id,
    username: creator.instagramUsername,
    accountType: creator.instagramAccountType,
    connectedAt: creator.instagramConnectedAt,
    tokenExpiresAt: expiresAt,
    daysUntilTokenExpiry,
    needsRefresh:
      daysUntilTokenExpiry !== null &&
      daysUntilTokenExpiry <= TOKEN_REFRESH_THRESHOLD_DAYS,
  };
}

/* -------------------------------------------------------------------------- */
/* Live health check                                                           */
/* -------------------------------------------------------------------------- */

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface HealthCheckStep {
  name: string;
  status: CheckStatus;
  /** Safe for display. Never contains a token. */
  detail: string;
}

export interface InstagramHealthCheck {
  ok: boolean;
  checkedAt: string;
  steps: HealthCheckStep[];
  profile: {
    instagramUserId: string;
    username: string;
    accountType: string | undefined;
    mediaCount: number | undefined;
  } | null;
  latestMedia: {
    id: string;
    mediaType: string | undefined;
    mediaProductType: string | undefined;
    permalink: string | undefined;
    timestamp: string | undefined;
  } | null;
  insights: Record<string, number> | null;
}

/** Meta's error codes and our own messages are safe; raw errors are not. */
function describeError(error: unknown): string {
  if (error instanceof InstagramOAuthError) {
    return error.metaCode
      ? `${error.message} (Meta code ${error.metaCode})`
      : error.message;
  }
  if (error instanceof SecretBoxError) return error.message;
  return 'Unexpected failure — see server logs';
}

export async function runInstagramHealthCheck(
  clerkUserId: string,
): Promise<InstagramHealthCheck> {
  const steps: HealthCheckStep[] = [];
  const result: InstagramHealthCheck = {
    ok: false,
    checkedAt: new Date().toISOString(),
    steps,
    profile: null,
    latestMedia: null,
    insights: null,
  };

  const record = await prisma.creator.findFirst({
    where: { user: { clerkId: clerkUserId }, deletedAt: null },
    select: {
      instagramUserId: true,
      instagramTokenCiphertext: true,
      instagramTokenExpiresAt: true,
    },
  });

  if (!record?.instagramUserId || !record.instagramTokenCiphertext) {
    steps.push({
      name: 'stored_connection',
      status: 'fail',
      detail: 'No Instagram connection is stored for this account',
    });
    return result;
  }

  steps.push({
    name: 'stored_connection',
    status: 'pass',
    detail: `Linked to Instagram user ${record.instagramUserId}`,
  });

  // Expiry is reported but not treated as fatal: the only authority on
  // whether a token still works is Meta, and a stale expiry column would
  // otherwise mask a token that is in fact fine.
  const expiresAt = record.instagramTokenExpiresAt;
  steps.push(
    expiresAt
      ? {
          name: 'token_expiry',
          status: expiresAt.getTime() > Date.now() ? 'pass' : 'fail',
          detail: `Stored expiry ${expiresAt.toISOString()}`,
        }
      : {
          name: 'token_expiry',
          status: 'skip',
          detail: 'No expiry recorded',
        },
  );

  let accessToken: string;
  try {
    accessToken = decryptSecret(
      record.instagramTokenCiphertext,
      TOKEN_ENCRYPTION_CONTEXT,
    );
    steps.push({
      name: 'decrypt_token',
      status: 'pass',
      detail: 'Ciphertext decrypted and authentication tag verified',
    });
  } catch (error) {
    // Almost always a rotated INSTAGRAM_TOKEN_ENCRYPTION_KEY. Nothing
    // downstream can run, so stop here.
    steps.push({
      name: 'decrypt_token',
      status: 'fail',
      detail: describeError(error),
    });
    return result;
  }

  try {
    const profile = await fetchInstagramProfile(accessToken);
    result.profile = {
      instagramUserId: profile.instagramUserId,
      username: profile.username,
      accountType: profile.rawAccountType,
      mediaCount: profile.mediaCount,
    };
    steps.push({
      name: 'token_accepted',
      status: 'pass',
      detail: `Meta accepted the token and returned @${profile.username}`,
    });

    // Catches the worst-case silent bug: a token that works but belongs to
    // a different Instagram account than the row claims.
    steps.push({
      name: 'identity_match',
      status:
        profile.instagramUserId === record.instagramUserId ? 'pass' : 'fail',
      detail:
        profile.instagramUserId === record.instagramUserId
          ? 'Token identity matches the stored Instagram user id'
          : `Token belongs to ${profile.instagramUserId}, row says ${record.instagramUserId}`,
    });
  } catch (error) {
    steps.push({
      name: 'token_accepted',
      status: 'fail',
      detail: describeError(error),
    });
    return result;
  }

  let latest: Awaited<ReturnType<typeof fetchRecentMedia>>[number] | undefined;

  try {
    const media = await fetchRecentMedia(accessToken, 3);
    latest = media[0];
    result.latestMedia = latest
      ? {
          id: latest.id,
          mediaType: latest.mediaType,
          mediaProductType: latest.mediaProductType,
          permalink: latest.permalink,
          timestamp: latest.timestamp,
        }
      : null;
    steps.push({
      name: 'media_read',
      status: 'pass',
      detail: `instagram_business_basic works — ${media.length} recent item(s) readable`,
    });
  } catch (error) {
    steps.push({
      name: 'media_read',
      status: 'fail',
      detail: describeError(error),
    });
    return result;
  }

  if (!latest) {
    // Not a failure of the integration. Post a reel and re-run.
    steps.push({
      name: 'insights_read',
      status: 'skip',
      detail: 'Account has no media yet, so insights cannot be verified',
    });
    result.ok = steps.every((step) => step.status !== 'fail');
    return result;
  }

  try {
    const insights = await fetchMediaInsights(accessToken, latest.id);
    result.insights = insights;

    const views = insights.views;
    steps.push({
      name: 'insights_read',
      status: typeof views === 'number' ? 'pass' : 'fail',
      detail:
        typeof views === 'number'
          ? `instagram_business_manage_insights works — views=${views}`
          : `Insights returned no 'views' metric (got: ${Object.keys(insights).join(', ') || 'nothing'})`,
    });
  } catch (error) {
    // A 403 here almost always means the creator unticked the insights
    // permission on the consent screen. This is the check that catches it.
    steps.push({
      name: 'insights_read',
      status: 'fail',
      detail: describeError(error),
    });
  }

  result.ok = steps.every((step) => step.status !== 'fail');
  return result;
}
