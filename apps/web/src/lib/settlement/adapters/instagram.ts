// apps/web/src/lib/settlement/adapters/instagram.ts
//
// Instagram MetricsProvider adapter for settleSlot().
//
// GATED AT THE ROUTE LAYER: settlement for Instagram is currently blocked by
// the fail-closed platform gate (INSTAGRAM: false) in
// supported-platforms.ts, enforced in POST
// /api/campaigns/slots/[slotId]/approve and POST
// /api/campaigns/slots/[slotId]/submit. parseContentUrl still recognises
// /p/ and /reel/ URLs, but any Instagram slot is rejected before submission
// and before approval — it can never reach settleSlot().
//
// UNIMPLEMENTED: Instagram's fetchMediaInsights returns a
// Record<string, number> which does not include the raw settlement
// snapshot shape that VideoSettlement provides for YouTube. The engine
// stores settlementJson for dispute evidence. Until Instagram's insights
// shape is wrapped in a typed settlement snapshot equivalent, this
// adapter throws UnsupportedPlatformError, which settleSlot() catches and
// turns into a clean SKIPPED_NOT_ELIGIBLE / 'platform_not_supported'
// result — no crash, no writes.
//
// REMOVAL CRITERIA (flip INSTAGRAM: true in supported-platforms.ts only when
// ALL hold): (a) the adapter returns a typed settlement snapshot; (b) the
// billable metric is verified as 'views'; (c) an ownership check for Instagram
// media exists; (d) tests cover all of the above.
//
// See supported-platforms.ts for the single source of truth and gate.

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
