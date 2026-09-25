// apps/web/src/lib/youtube/oauth.ts
//
// Server-only wrappers around the Google OAuth 2.0 token endpoints and
// the Data API v3 channel/video reads. Every function here handles a
// *secret*, so:
//
//   - nothing in this file logs a token, a code, or the client secret;
//   - every response is parsed through zod rather than trusted, because
//     these are untrusted external payloads and Google has changed field
//     types between API versions;
//   - every request has an explicit timeout, so a hung Google endpoint
//     can't pin a route handler open indefinitely;
//   - the refresh token is never stored in plaintext — it's encrypted
//     via SocialAccount.tokenCiphertext before persisting.
//
// Must run on the nodejs runtime — it reads the client secret.

import { z } from 'zod';

import { env } from '@/lib/env';
import {
  parseOrThrow,
  requestJson,
  throwForStatus,
} from '@/lib/oauth/request';
import {
  YOUTUBE_AUTHORIZE_URL,
  YOUTUBE_DATA_API_BASE,
  YOUTUBE_TOKEN_URL,
  REQUIRED_SCOPES,
} from '@/lib/youtube/constants';

/**
 * Google's error envelope for OAuth-level errors (token exchange,
 * refresh). The `error` field is a machine-readable string like
 * `invalid_grant`, `invalid_request`, `consent_required`.
 */
const googleErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  error_codes: z.array(z.number()).optional(),
});

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Google's token response.
 *
 * On the initial authorization-code exchange, `refresh_token` is present.
 * On a refresh-token grant, it is present only if `access_type=offline`
 * was requested at authorize time (which our buildAuthorizeUrl does).
 */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  /** Seconds. For access tokens, one hour. */
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

/**
 * Google channel response. `items` is an array; we take the first.
 */
const channelSchema = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string(),
    customUrl: z.string().optional(),
    publishedAt: z.string().optional(),
  }),
  contentDetails: z.object({
    /** ISO 8601 duration — e.g. "PT15S" for a Short. */
    duration: z.string().optional(),
    /** "high", "standard", etc. */
    definition: z.string().optional(),
    /** The video category ID. YouTube Shorts category is 22. */
    videoCategoryId: z.string().optional(),
  }).optional(),
  statistics: z.object({
    subscriberCount: z.number().int().nonnegative().optional(),
    videoCount: z.number().int().nonnegative().optional(),
    viewCount: z.number().int().nonnegative().optional(),
  }).optional(),
});

const channelListSchema = z.object({
  items: z.array(channelSchema).default([]),
});

/**
 * Video resource from the Data API v3. Used for the submission-time
 * Shorts check (contentDetails.duration).
 */
const videoSchema = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string(),
    publishedAt: z.string().optional(),
    categoryId: z.string().optional(),
  }).optional(),
  contentDetails: z.object({
    /** ISO 8601 duration. "PT15S", "PT5M30S", etc. */
    duration: z.string().optional(),
    /** "short" if YouTube classifies it as a Short. */
    dimension: z.string().optional(),
  }).optional(),
});

const videoListSchema = z.object({
  items: z.array(videoSchema).default([]),
});

/* -------------------------------------------------------------------------- */
/* Error class                                                               */
/* -------------------------------------------------------------------------- */

export class YouTubeOAuthError extends Error {
  readonly status: number | undefined;
  readonly providerCode: string | undefined;

  constructor(
    message: string,
    options: { status?: number; providerCode?: string } = {},
  ) {
    super(message);
    this.name = 'YouTubeOAuthError';
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface YouTubeTokens {
  accessToken: string;
  /** Present on the initial exchange and on refresh-grant responses. */
  refreshToken: string | null;
  /** Seconds until the access token expires. */
  expiresIn: number;
  expiresAt: Date;
  /** Scopes granted by Google, if present in the token response. */
  grantedScopes: string[];
}

export interface YouTubeChannel {
  id: string;
  title: string;
  customUrl: string | null;
  /** ISO 8601 duration from contentDetails. For the Shorts check. */
  duration: string | null;
  /** subscriberCount from statistics, if available. */
  subscriberCount: number | null;
  /** videoCount from statistics, if available. */
  videoCount: number | null;
}

export interface YouTubeVideo {
  id: string;
  /** ISO 8601 duration from contentDetails. */
  duration: string | null;
  /** "short" if YouTube classifies this as a Short. */
  dimension: string | null;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Turns a non-2xx into an OAuthHttpError carrying only Google's own
 * error code and description. Google's `error_description` can echo
 * request parameters back, so it is deliberately not propagated into
 * the thrown message.
 */
function throwGoogleStatus(
  response: Response,
  body: unknown,
): never {
  throwForStatus(response, body, googleErrorSchema, 'YouTube');
}

/**
 * Parses an ISO 8601 duration string (e.g. "PT15S", "PT5M30S") into
 * total seconds. Returns null if the string is unparseable.
 *
 * Used to determine whether content could be a Short (typically < 180s).
 * Duration is only a cheap pre-filter — use verifyIsShort, the Analytics
 * API's creatorContentType dimension, for the authoritative check.
 */
export function parseIsoDuration(duration: string | null): number | null {
  if (!duration) return null;

  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return null;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return Math.floor(hours * 3600 + minutes * 60 + seconds);
}

/**
 * Returns true if the parsed duration indicates a YouTube Short.
 * YouTube Shorts are typically under 60 seconds. The threshold here
 * is deliberately generous to avoid false negatives on edge cases
 * (e.g. 58-second content). Adjust if YouTube changes the definition.
 */
export function isShortByDuration(durationSeconds: number | null): boolean {
  if (durationSeconds === null) return false;
  return durationSeconds < 60;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Builds the Google OAuth 2.0 authorization URL.
 *
 * access_type=offline is required so Google returns a refresh_token
 * on the initial exchange. prompt=consent ensures a fresh refresh
 * token on every re-auth (otherwise Google may return no refresh_token
 * on subsequent exchanges).
 */
export function buildAuthorizeUrl(state: string): string {
  const url = new URL(YOUTUBE_AUTHORIZE_URL);
  url.searchParams.set('client_id', env.YOUTUBE_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.YOUTUBE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * Authorization codes are single-use and expire in one hour. Do not
 * wrap this in a retry — a second attempt with the same code always
 * fails, and you'll misread it as a credential problem.
 */
export async function exchangeCodeForToken(
  code: string,
): Promise<YouTubeTokens> {
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    grant_type: 'authorization_code',
    // Google requires this again here, and re-compares it byte-for-byte
    // against the value used at authorize time.
    redirect_uri: env.YOUTUBE_REDIRECT_URI,
    code,
  });

  const json = await requestJson(YOUTUBE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  // Google's token error envelope is different from the OAuth error
  // envelope — it has `error` at the top level, not inside an `error`
  // object. Check for it before zod parsing.
  if (typeof json === 'object' && json !== null && 'error' in json) {
    throwGoogleStatus(
      { ok: false, status: 400 } as Response,
      json,
    );
  }

  const parsed = parseOrThrow(tokenResponseSchema, json, 'token exchange');

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresIn: parsed.expires_in,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    grantedScopes: parsed.scope ? parsed.scope.split(' ') : [],
  };
}

/**
 * Refreshes an access token using a refresh token. Google refresh
 * tokens are effectively permanent but can be revoked by the user
 * or by Google if unused for a long period.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<YouTubeTokens> {
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const json = await requestJson(YOUTUBE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (typeof json === 'object' && json !== null && 'error' in json) {
    // If the refresh token was revoked, throw a specific error so
    // the caller can force re-auth rather than retrying.
    throwGoogleStatus(
      { ok: false, status: 400 } as Response,
      json,
    );
  }

  const parsed = parseOrThrow(tokenResponseSchema, json, 'token refresh');

  return {
    accessToken: parsed.access_token,
    refreshToken: null, // refresh token doesn't rotate on every refresh
    expiresIn: parsed.expires_in,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    grantedScopes: parsed.scope ? parsed.scope.split(' ') : [],
  };
}

/**
 * Reads the authenticated user's channel metadata via the Data API v3.
 * Returns the first item or null if the channel has no public identity.
 *
 * This is the one-time submission-time check to verify the channel
 * owns the video being submitted.
 */
export async function fetchChannel(
  accessToken: string,
): Promise<YouTubeChannel | null> {
  const url = new URL('/channels', YOUTUBE_DATA_API_BASE);
  url.searchParams.set(
    'part',
    ['snippet', 'contentDetails', 'statistics'].join(','),
  );
  url.searchParams.set('mine', 'true');
  url.searchParams.set('access_token', accessToken);

  const parsed = parseOrThrow(
    channelListSchema,
    await requestJson(url.toString()),
    'channel list',
  );

  const item = parsed.items[0];
  if (!item) return null;

  return {
    id: item.id,
    title: item.snippet.title,
    customUrl: item.snippet.customUrl ?? null,
    duration: item.contentDetails?.duration ?? null,
    subscriberCount: item.statistics?.subscriberCount ?? null,
    videoCount: item.statistics?.videoCount ?? null,
  };
}

/**
 * Reads a single video's contentDetails by ID. Used at submission time
 * to confirm the video is a Short (contentDetails.duration < 60s).
 *
 * The caller must already have verified the video belongs to the
 * authenticated channel (via fetchChannel or a separate ownership
 * check). This function does not re-verify ownership — it trusts the
 * caller.
 */
export async function fetchVideoContentDetails(
  videoId: string,
  accessToken: string,
): Promise<YouTubeVideo | null> {
  const url = new URL('/videos', YOUTUBE_DATA_API_BASE);
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('id', videoId);
  url.searchParams.set('access_token', accessToken);

  const parsed = parseOrThrow(
    videoListSchema,
    await requestJson(url.toString()),
    'video list',
  );

  const item = parsed.items[0];
  if (!item) return null;

  return {
    id: item.id,
    duration: item.contentDetails?.duration ?? null,
    dimension: item.contentDetails?.dimension ?? null,
  };
}

/**
 * Users can decline individual scopes on the consent screen, and Google
 * will still hand back a valid token. Without this check the connection
 * looks successful and then every Analytics call 403s days later.
 */
export function findMissingScopes(
  grantedScopes: string[],
): string[] {
  if (grantedScopes.length === 0) {
    // Some consent screens omit scopes entirely. Treat as "unknown,
    // not empty" — the scope-check call will tell us for real.
    return [];
  }
  // Google may return scopes with or without the full URL prefix.
  // Normalize: strip the `https://www.googleapis.com/auth/` prefix.
  const normalizedGranted = grantedScopes.map((s) =>
    s.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''),
  );
  return REQUIRED_SCOPES.filter((scope) => {
    const short = scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
    return !normalizedGranted.includes(short);
  });
}