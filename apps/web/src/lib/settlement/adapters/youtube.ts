// apps/web/src/lib/settlement/adapters/youtube.ts
//
// YouTube MetricsProvider adapter for settleSlot().
//
// Wiring: decryptToken(ciphertext, YOUTUBE) → refreshAccessToken(refreshToken)
//         → fetchVideoSettlement(contentId, startDate, endDate, accessToken)
//
// The 404 case (no analytics rows yet) is mapped to OAuthHttpError(404)
// by parseVideoSettlement() in analytics.ts — settleSlot() catches this
// and returns HELD_NO_DATA. Any other error rethrows.
//
// This adapter NEVER logs tokens. It logs only contentId and outcome.

import { SocialPlatform } from '@repo/database';
import { decryptToken } from '@/lib/crypto/secret-box';
import { refreshAccessToken } from '@/lib/youtube/oauth';
import { fetchVideoSettlement } from '@/lib/youtube/analytics';
import type { MetricsProvider, MetricsResult } from '../settle-slot';
import { UnsupportedPlatformError } from '../settle-slot';
import { getBillableMetric } from '../tiers';

/**
 * YouTube metrics provider.
 *
 * Decrypts the stored refresh token, exchanges it for a short-lived access
 * token, then fetches VideoSettlement for the date range.
 *
 * The accessToken parameter is the ENCRYPTED ciphertext from
 * SocialAccount.tokenCiphertext — this adapter owns the decrypt step.
 */
export const youtubeMetricsProvider: MetricsProvider = {
  async fetchMetrics({ platform, contentId, startDate, endDate, accessToken: ciphertext }) {
    if (platform !== SocialPlatform.YOUTUBE) {
      throw new UnsupportedPlatformError(platform);
    }

    // Step 1: decrypt the refresh token (AES-256-GCM, platform-scoped key)
    const refreshToken = decryptToken(ciphertext, SocialPlatform.YOUTUBE);

    // Step 2: exchange for a fresh access token (1-hour TTL)
    const { accessToken } = await refreshAccessToken(refreshToken);

    // Step 3: fetch settlement metrics
    // fetchVideoSettlement throws OAuthHttpError(404) when no rows are returned —
    // settleSlot() maps 404 to HELD_NO_DATA automatically.
    const settlement = await fetchVideoSettlement(
      contentId,
      startDate,
      endDate,
      accessToken,
    );

    const metricName = getBillableMetric(SocialPlatform.YOUTUBE); // 'engagedViews'

    return {
      billableViews: settlement[metricName],
      billableMetric: metricName,
      settlementSnapshot: settlement,
    } satisfies MetricsResult;
  },
};
