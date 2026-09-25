// apps/web/src/lib/youtube/analytics.ts
//
// Reads YouTube Analytics API v2 for settlement metrics and Shorts classification.
// Every function here handles a *secret* (accessToken), so:
//
//   - nothing logs the accessToken or raw response body on failure;
//   - every response is parsed through zod rather than trusted;
//   - every request has an explicit timeout;
//   - non-2xx responses are turned into a typed error carrying only the API's own error code
//     (never a message that echoes request parameters back);
//   - implements exponential backoff with jitter for rate limits (429) and transient errors (5xx);
//   - never retries permanent errors (4xx except 429).

import { z } from 'zod';

import { YOUTUBE_ANALYTICS_API_BASE } from '@/lib/youtube/constants';
import {
  computeBackoffMs,
  OAuthHttpError,
  parseOrThrow,
  requestJsonWithHeaders,
  sleep,
  throwForStatus,
} from '@/lib/oauth/request';

const MAX_RETRIES = 3;

/**
 * YouTube Analytics API error envelope. Based on Google's standard error format.
 * The `errors` array contains error objects; we extract the first one's `reason`
 * as the safe providerCode.
 */
const youtubeAnalyticsErrorSchema = z.object({
  error: z.object({
    errors: z.array(
      z.object({
        reason: z.string(),
        message: z.string().optional(),
      }),
    ).nonempty(),
    code: z.number(),
    message: z.string(),
  }),
});

/**
 * Response schema for the YouTube Analytics API reports query.
 * Returns an object with `columnHeaders` and `rows`.
 * `columnHeaders` describes the order of metrics in each row.
 * `rows` is an array of arrays - each inner array is a row of metric values.
 * For our query (no dimensions, filtering by video==<videoId>), we expect exactly one row.
 */
const analyticsReportSchema = z.object({
  columnHeaders: z.array(
    z.object({
      name: z.string(),
      dataType: z.string(), // e.g. "METRIC", "DIMENSION"
      columnType: z.string().optional(), // e.g. "INTEGER", "FLOAT", "TIME"
    }),
  ),
  rows: z.array(z.array(z.union([z.number(), z.string()]))),
});

/**
 * Settlement metrics returned by fetchVideoSettlement.
 * Matches the 9 metrics requested in the confirmed working query.
 */
export interface VideoSettlement {
  views: number;
  engagedViews: number;
  estimatedMinutesWatched: number;
  averageViewPercentage: number;
  likes: number;
  comments: number;
  shares: number;
  subscribersGained: number;
  videosAddedToPlaylists: number;
}

/**
 * Internal helper to convert the Analytics API response rows into a VideoSettlement object.
 * Assumes the column order matches the metrics requested in the query.
 */
function parseVideoSettlement(parsed: z.infer<typeof analyticsReportSchema>): VideoSettlement {
  if (parsed.rows.length === 0) {
    // No data for this video in the date range - return zeros
    return {
      views: 0,
      engagedViews: 0,
      estimatedMinutesWatched: 0,
      averageViewPercentage: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      subscribersGained: 0,
      videosAddedToPlaylists: 0,
    };
  }

  if (parsed.rows.length > 1) {
    // Should not happen with our query (filtering by specific videoId + no dimensions)
    // but handle gracefully
    console.warn('[youtube] Analytics API returned multiple rows for single video query');
  }

  const row = parsed.rows[0];
  const columnNames = parsed.columnHeaders.map((header) => header.name);

  // Create a map of metric name -> value for easy lookup
  const metricMap = new Map<string, number>();
  columnNames.forEach((name, index) => {
    const value = row[index];
    // YouTube Analytics API returns numbers as numbers, strings as strings
    // Our metrics should all be numeric
    if (typeof value === 'number') {
      metricMap.set(name, value);
    } else {
      // Try to parse string numbers (shouldn't happen for our metrics but be safe)
      const parsedNum = Number(value);
      if (!isNaN(parsedNum)) {
        metricMap.set(name, parsedNum);
      } else {
        console.warn(`[youtube] Unexpected non-numeric value for metric ${name}: ${value}`);
        metricMap.set(name, 0);
      }
    }
  });

  // Extract the 9 metrics we requested, defaulting to 0 if missing
  return {
    views: metricMap.get('views') ?? 0,
    engagedViews: metricMap.get('engagedViews') ?? 0,
    estimatedMinutesWatched: metricMap.get('estimatedMinutesWatched') ?? 0,
    averageViewPercentage: metricMap.get('averageViewPercentage') ?? 0,
    likes: metricMap.get('likes') ?? 0,
    comments: metricMap.get('comments') ?? 0,
    shares: metricMap.get('shares') ?? 0,
    subscribersGained: metricMap.get('subscribersGained') ?? 0,
    videosAddedToPlaylists: metricMap.get('videosAddedToPlaylists') ?? 0,
  };
}

/**
 * Extract Retry-After header value in milliseconds.
 * The header can be a number of seconds or an HTTP date.
 * We only handle the seconds case (most common for rate limits).
 */
function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('Retry-After');
  if (!value) return undefined;
  const seconds = Number(value);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  // Could be an HTTP date, but we'll ignore that for now
  return undefined;
}

/**
 * Fetch settlement metrics for a single video over a date range.
 *
 * Confirmed working query shape:
 *   GET https://youtubeanalytics.googleapis.com/v2/reports
 *     ?ids=channel==MINE
 *     &startDate=<startDate>&endDate=<endDate>
 *     &filters=video==<videoId>
 *     &metrics=views,engagedViews,estimatedMinutesWatched,averageViewPercentage,likes,comments,shares,subscribersGained,videosAddedToPlaylists
 *
 * No dimensions parameter — returns one row with all nine metrics.
 *
 * Note on averageViewPercentage: YouTube computes this as
 * average-view-duration ÷ video-length, and loopable Shorts get
 * rewatched in one session, so values over 100 are legitimate.
 * We type it as an uncapped ratio — no 0–100 clamp, no validation
 * that rejects values over 100.
 *
 * Note on Shorts view-counting (March 2025): YouTube changed how
 * it counts Shorts views — plays with no minimum watch-time threshold
 * are now counted. This affects how the payout engine should interpret
 * the views number, but doesn't change this function's implementation.
 *
 * @param videoId - The YouTube video ID
 * @param startDate - Inclusive start date in YYYY-MM-DD format
 * @param endDate - Inclusive end date in YYYY-MM-DD format
 * @param accessToken - OAuth 2.0 access token with yt-analytics.readonly scope
 * @returns Promise resolving to VideoSettlement object
 * @throws OAuthHttpError on non-2xx responses (with safe error codes)
 */
export async function fetchVideoSettlement(
  videoId: string,
  startDate: string,
  endDate: string,
  accessToken: string,
): Promise<VideoSettlement> {
  // Validate date format (basic check)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    throw new OAuthHttpError('Invalid date format. Expected YYYY-MM-DD', {
      status: 400,
    });
  }

  const url = new URL('/reports', YOUTUBE_ANALYTICS_API_BASE);
  url.searchParams.set('ids', 'channel==MINE');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  url.searchParams.set('filters', `video==${videoId}`);
  url.searchParams.set(
    'metrics',
    'views,engagedViews,estimatedMinutesWatched,averageViewPercentage,likes,comments,shares,subscribersGained,videosAddedToPlaylists'
  );
  // Note: intentionally NO dimensions parameter
  url.searchParams.set('access_token', accessToken);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let result: { body: unknown; headers: Headers; status: number };
    try {
      result = await requestJsonWithHeaders(url.toString());
    } catch (error) {
      // Network/timeout error - retryable
      if (error instanceof OAuthHttpError && attempt < MAX_RETRIES) {
        await sleep(computeBackoffMs(attempt));
        continue;
      }
      throw error;
    }

    // HTTP error status
    if (result.status !== 200) {
      // Retry on rate limits (429) and server errors (5xx)
      if ((result.status === 429 || result.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfterMs = parseRetryAfter(result.headers);
        await sleep(computeBackoffMs(attempt, retryAfterMs));
        continue;
      }
      // Non-retryable or exhausted retries - throw with safe error code
      throwForStatus(
        { ok: false, status: result.status } as Response,
        result.body,
        youtubeAnalyticsErrorSchema,
        'YouTube Analytics',
      );
    }

    // Check for API-level error in the response body
    if (typeof result.body === 'object' && result.body !== null && 'error' in result.body) {
      throwForStatus(
        { ok: false, status: 400 } as Response,
        result.body,
        youtubeAnalyticsErrorSchema,
        'YouTube Analytics',
      );
    }

    const parsed = parseOrThrow(analyticsReportSchema, result.body, 'analytics report');
    return parseVideoSettlement(parsed);
  }

  throw new OAuthHttpError('Failed to fetch video settlement after retries');
}

/**
 * Verify if a video is classified as a Short by YouTube's own classification.
 *
 * Submission-time check, called once when a creator submits a video.
 * Uses the Analytics API's creatorContentType dimension against the channel report.
 *
 * @confirmed The dimensions=video,creatorContentType pairing fails with 400.
 *            Instead, query creatorContentType against the channel report on its own,
 *            matching the workaround in this codebase's own history.
 *
 * Note on Shorts view-counting (March 2025): YouTube changed how it counts
 * Shorts views — plays with no minimum watch-time threshold are now counted.
 * This affects how the payout engine should interpret the views number,
 * but doesn't change this function's implementation.
 *
 * @param videoId - The YouTube video ID
 * @param accessToken - OAuth 2.0 access token with yt-analytics.readonly scope
 * @returns Promise resolving to true if YouTube classifies the video as a Short
 * @throws OAuthHttpError on non-2xx responses (with safe error codes)
 */
export async function verifyIsShort(
  videoId: string,
  accessToken: string,
): Promise<boolean> {
  // Validate videoId format (basic check - YouTube IDs are 11 chars)
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new OAuthHttpError('Invalid video ID format', {
      status: 400,
    });
  }

  // Query for creatorContentType dimension only (no video dimension due to API limitations)
  // This matches the workaround mentioned in the task description
  const url = new URL('/reports', YOUTUBE_ANALYTICS_API_BASE);
  url.searchParams.set('ids', 'channel==MINE');
  url.searchParams.set('startDate', '2020-01-01'); // Far enough back to cover all videos
  url.searchParams.set('endDate', '2030-01-01'); // Far enough forward
  url.searchParams.set('filters', `video==${videoId}`);
  url.searchParams.set('dimensions', 'creatorContentType');
  url.searchParams.set('metrics', 'views'); // Need at least one metric
  url.searchParams.set('access_token', accessToken);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let result: { body: unknown; headers: Headers; status: number };
    try {
      result = await requestJsonWithHeaders(url.toString());
    } catch (error) {
      if (error instanceof OAuthHttpError && attempt < MAX_RETRIES) {
        await sleep(computeBackoffMs(attempt));
        continue;
      }
      throw error;
    }

    if (result.status !== 200) {
      if ((result.status === 429 || result.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfterMs = parseRetryAfter(result.headers);
        await sleep(computeBackoffMs(attempt, retryAfterMs));
        continue;
      }
      throwForStatus(
        { ok: false, status: result.status } as Response,
        result.body,
        youtubeAnalyticsErrorSchema,
        'YouTube Analytics',
      );
    }

    if (typeof result.body === 'object' && result.body !== null && 'error' in result.body) {
      throwForStatus(
        { ok: false, status: 400 } as Response,
        result.body,
        youtubeAnalyticsErrorSchema,
        'YouTube Analytics',
      );
    }

    const parsed = parseOrThrow(analyticsReportSchema, result.body, 'analytics report');

    // Check if any row has creatorContentType == "SHORT"
    for (const row of parsed.rows) {
      if (row.length >= 2) {
        const dimensionValue = row[0]; // creatorContentType is first (dimensions)
        if (typeof dimensionValue === 'string' && dimensionValue.toUpperCase() === 'SHORT') {
          // Found a row where creatorContentType is SHORT - this is a Short
          return true;
        }
      }
    }

    // If we get here, no SHORT classification found
    return false;
  }

  throw new OAuthHttpError('Failed to verify Short status after retries');
}
