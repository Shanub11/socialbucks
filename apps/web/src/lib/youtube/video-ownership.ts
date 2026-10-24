// apps/web/src/lib/youtube/video-ownership.ts
//
// Checks that a YouTube video belongs to a specific channel by querying the
// Data API v3 `videos.list` endpoint with `part=snippet` and comparing
// `snippet.channelId` against the creator's known `SocialAccount.externalId`.
//
// Security rules (same as analytics.ts and request.ts):
//   - nothing logs an accessToken, Authorization header, or raw response body;
//   - every response is validated through zod before any value is read;
//   - every request has an explicit timeout (via requestJsonWithHeaders);
//   - a single attempt, no internal retry — the caller (submit route) can retry;
//   - non-2xx responses are surfaced as OAuthHttpError with only the provider's
//     own error code, never a message echoing request parameters back.

import { z } from 'zod';

import { YOUTUBE_DATA_API_BASE } from '@/lib/youtube/constants';
import {
  OAuthHttpError,
  parseOrThrow,
  requestJsonWithHeaders,
  throwForStatus,
} from '@/lib/oauth/request';

/**
 * YouTube Data API v3 error envelope.
 * Mirrors the shape used by analytics.ts for consistency.
 */
const youtubeDataApiErrorSchema = z.object({
  error: z.object({
    errors: z
      .array(
        z.object({
          reason: z.string(),
          message: z.string().optional(),
        }),
      )
      .nonempty(),
    code: z.number(),
    message: z.string(),
  }),
});

/**
 * Success body schema for `videos.list?part=snippet`.
 *
 * We only extract `snippet.channelId` — nothing else is read or stored.
 * The channelId regex enforces the canonical `UC` + 22-char format
 * so a malformed response is rejected rather than silently accepted.
 */
const videoListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({
        channelId: z.string().regex(/^UC[a-zA-Z0-9_-]{22}$/),
      }),
    }),
  ),
});

/** Regex for a canonical YouTube video ID: exactly 11 URL-safe characters. */
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Discriminated union returned by fetchVideoChannel.
 *
 * - `{ found: false }` — the video does not exist, is private, or the returned
 *   ID did not match the requested ID (unexpected API behaviour).
 * - `{ found: true; channelId: string }` — the video exists and `channelId`
 *   is the `UC…` channel to which it belongs.
 */
export type VideoChannelResult =
  | { found: false }
  | { found: true; channelId: string };

/**
 * Checks which channel a YouTube video belongs to.
 *
 * Calls `GET /youtube/v3/videos?part=snippet&id=<videoId>` with the caller's
 * access token in the Authorization header. The response's
 * `items[0].snippet.channelId` identifies the owning channel.
 *
 * @param videoId     - 11-character YouTube video ID.
 * @param accessToken - A valid OAuth 2.0 access token with `youtube.readonly`
 *                      scope. Never included in the URL.
 * @returns           - `{ found: false }` when the video is missing or
 *                      inaccessible; `{ found: true; channelId }` otherwise.
 * @throws OAuthHttpError (status 400) when `videoId` fails format validation.
 * @throws OAuthHttpError on non-2xx API responses or malformed response bodies,
 *         with `providerCode` set to the API's own error reason.
 * @throws OAuthHttpError on network timeout or connection failure.
 */
export async function fetchVideoChannel(
  videoId: string,
  accessToken: string,
): Promise<VideoChannelResult> {
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new OAuthHttpError('Invalid YouTube video ID format', { status: 400 });
  }

  // Build the URL with searchParams — never string concatenation — so
  // a pathological videoId cannot inject additional query parameters.
  const url = new URL(`${YOUTUBE_DATA_API_BASE}/videos`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('id', videoId);

  // Auth goes in the Authorization header only, never in the URL.
  const { body, status } = await requestJsonWithHeaders(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (status !== 200) {
    // Surface the API's own error code without echoing request parameters.
    throwForStatus(
      { ok: false, status } as Response,
      body,
      youtubeDataApiErrorSchema,
      'YouTube Data API',
    );
  }

  // Reject an API-level error body whose HTTP status happened to be 200
  // (unusual but observed from some Google APIs).
  if (typeof body === 'object' && body !== null && 'error' in body) {
    throwForStatus(
      { ok: false, status: 400 } as Response,
      body,
      youtubeDataApiErrorSchema,
      'YouTube Data API',
    );
  }

  const parsed = parseOrThrow(videoListSchema, body, 'videos.list snippet');

  if (parsed.items.length === 0) {
    return { found: false };
  }

  const item = parsed.items[0];

  // Guard against an API that returns a different video than requested
  // (should not happen, but fail closed).
  if (item.id !== videoId) {
    return { found: false };
  }

  return { found: true, channelId: item.snippet.channelId };
}
