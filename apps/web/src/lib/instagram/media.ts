// TARGET PATH: apps/web/src/lib/instagram/media.ts
//
// Reads of a connected creator's media, and the insights call that produces
// the view count CampaignCreatorSlot.currentViewCount is settled against.
//
// This module exists mainly so the connection can be *proved* rather than
// assumed: a stored token that decrypts is not the same thing as a token
// Meta still honours, and a token Meta honours is not the same thing as a
// token carrying instagram_business_manage_insights. Only an actual
// /insights call distinguishes the last case, and discovering it at payout
// time is far too late.
//
// Node-only (reuses oauth.ts, which reads the app secret).

import { z } from 'zod';

import { INSTAGRAM_GRAPH_BASE } from '@/lib/instagram/constants';
import { parseOrThrow, requestJson } from '@/lib/instagram/oauth';

/**
 * `views` is the metric that replaced the old plays/impressions family and
 * is what we settle milestones on. `reach` is requested alongside it purely
 * as a sanity signal — two numbers moving together is a cheap smell test
 * for a broken read.
 */
export const VIEW_METRICS = ['views', 'reach'] as const;

const mediaSchema = z.object({
  id: z.string().min(1),
  media_type: z.string().optional(),
  media_product_type: z.string().optional(),
  permalink: z.string().optional(),
  timestamp: z.string().optional(),
});

const mediaListSchema = z.object({
  data: z.array(mediaSchema).default([]),
});

/**
 * Insights have shipped in two shapes. Older: `values: [{ value: n }]`.
 * Newer: `total_value: { value: n }`. Accept both — a version bump on
 * Meta's side must not silently zero out a creator's payout.
 */
const insightEntrySchema = z.object({
  name: z.string(),
  values: z
    .array(z.object({ value: z.number().nullable().optional() }))
    .optional(),
  total_value: z.object({ value: z.number().nullable().optional() }).optional(),
});

const insightsSchema = z.object({
  data: z.array(insightEntrySchema).default([]),
});

export interface InstagramMedia {
  id: string;
  /** IMAGE / VIDEO / CAROUSEL_ALBUM */
  mediaType: string | undefined;
  /** REELS / FEED / STORY — this is what identifies a reel. */
  mediaProductType: string | undefined;
  permalink: string | undefined;
  timestamp: string | undefined;
}

export async function fetchRecentMedia(
  accessToken: string,
  limit = 3,
): Promise<InstagramMedia[]> {
  const url = new URL('/me/media', INSTAGRAM_GRAPH_BASE);
  url.searchParams.set(
    'fields',
    ['id', 'media_type', 'media_product_type', 'permalink', 'timestamp'].join(
      ',',
    ),
  );
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('access_token', accessToken);

  const parsed = parseOrThrow(
    mediaListSchema,
    await requestJson(url.toString()),
    'media list',
  );

  return parsed.data.map((item) => ({
    id: item.id,
    mediaType: item.media_type,
    mediaProductType: item.media_product_type,
    permalink: item.permalink,
    timestamp: item.timestamp,
  }));
}

/**
 * Returns a metric -> value map. A metric Meta declines to report for this
 * media type is simply absent from the map rather than reported as 0 —
 * zero is a legitimate view count and must stay distinguishable from
 * "unavailable".
 */
export async function fetchMediaInsights(
  accessToken: string,
  mediaId: string,
  metrics: readonly string[] = VIEW_METRICS,
): Promise<Record<string, number>> {
  const url = new URL(
    `/${encodeURIComponent(mediaId)}/insights`,
    INSTAGRAM_GRAPH_BASE,
  );
  url.searchParams.set('metric', metrics.join(','));
  url.searchParams.set('access_token', accessToken);

  const parsed = parseOrThrow(
    insightsSchema,
    await requestJson(url.toString()),
    'media insights',
  );

  const result: Record<string, number> = {};

  for (const entry of parsed.data) {
    const value = entry.total_value?.value ?? entry.values?.[0]?.value;
    if (typeof value === 'number') {
      result[entry.name] = value;
    }
  }

  return result;
}
