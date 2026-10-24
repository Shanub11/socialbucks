// apps/web/src/lib/settlement/supported-platforms.ts
//
// Single source of truth for which platforms are allowed to enter the
// settlement pipeline (submit -> approve -> settleSlot). Instagram is intentionally
// excluded: its adapter still throws UnsupportedPlatformError, so any Instagram
// slot would lock escrow forever.
//
// The map is typed as Record<SocialPlatform, boolean>. Adding a new platform to
// the Prisma SocialPlatform enum that is not added here produces a compile-time
// error, forcing a conscious decision at each platform's rollout.
//
// REMOVAL CRITERIA FOR INSTAGRAM (flip INSTAGRAM to true only when ALL of the
// following hold):
//   (a) the Instagram adapter returns a typed settlement snapshot
//       (metricsResult.settlementSnapshot typed, not unknown);
//   (b) the billable metric is verified as `views` per D2 of ADR-0002
//       (instagram -> views, not engagedViews);
//   (c) an ownership check for Instagram media exists (confirming the creator's
//       submitted content ID actually belongs to the connected account); and
//   (d) tests cover all of the above end-to-end.
//
// See the approve and submit route handlers for the gate that enforces this list.

import { SocialPlatform } from '@repo/database';

export const SETTLEMENT_SUPPORTED_PLATFORMS: Record<SocialPlatform, boolean> = Object.freeze({
  [SocialPlatform.YOUTUBE]: true,
  [SocialPlatform.INSTAGRAM]: false,
});

/**
 * Returns true only if settlement is enabled for this platform.
 *
 * Fail-closed: `null`, `undefined`, and any unknown runtime value all return
 * false. There is no type predicate here -- a `false` result does NOT narrow the
 * `SocialPlatform | null | undefined` input.
 */
export function isSettlementSupported(
  platform: SocialPlatform | null | undefined,
): boolean {
  if (platform == null) return false;
  return SETTLEMENT_SUPPORTED_PLATFORMS[platform as SocialPlatform] === true;
}