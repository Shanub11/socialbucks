// apps/web/src/lib/settlement/adapters/instagram.ts
//
// Instagram MetricsProvider adapter for settleSlot().
//
// FOLLOW-UP REQUIRED: Instagram's fetchMediaInsights returns a
// Record<string, number> which does not include the raw settlement
// snapshot shape that VideoSettlement provides for YouTube. The engine
// stores settlementJson for dispute evidence. Until Instagram's insights
// shape is wrapped in a typed settlement snapshot equivalent, this
// adapter throws UnsupportedPlatformError (fail-closed, D3 principle).
//
// This is explicitly a follow-up item — not an oversight.

import { SocialPlatform } from '@repo/database';
import type { MetricsProvider } from '../settle-slot';
import { UnsupportedPlatformError } from '../settle-slot';

/**
 * Instagram metrics provider — currently throws UnsupportedPlatformError.
 *
 * Follow-up: wrap fetchMediaInsights() from lib/instagram/media.ts into a
 * typed InstagramSettlement snapshot, verify the metric name is 'views',
 * and replace this stub with a real implementation.
 *
 * Until then, any INSTAGRAM slot returns SKIPPED_NOT_ELIGIBLE via the
 * UnsupportedPlatformError path (fail-closed).
 */
export const instagramMetricsProvider: MetricsProvider = {
  async fetchMetrics({ platform }) {
    if (platform !== SocialPlatform.INSTAGRAM) {
      throw new UnsupportedPlatformError(platform);
    }
    // Fail-closed: Instagram adapter not yet implemented.
    // See module header for follow-up plan.
    throw new UnsupportedPlatformError(SocialPlatform.INSTAGRAM);
  },
};
