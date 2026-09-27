// apps/web/src/lib/youtube/constants.ts
//
// Endpoints, scopes, and derived origins for YouTube Data API v3 and YouTube
// Analytics API v2. Kept separate from oauth.ts so the values are greppable
// and there is exactly one place to touch when Google moves a host.
//
// IMPORTANT: This file must not import from @/lib/env at module-parse time.
// analytics.ts and other pure-logic modules import YOUTUBE_ANALYTICS_API_BASE
// from here. If this file eagerly imports env, every test that imports
// analytics.ts drags in envSchema.parse() and fails unless all secrets are
// present. APP_ORIGIN is therefore a lazy getter — it reads env only when
// called, never on import.

/**
 * OAuth 2.0 authorization endpoint.
 *
 * Google uses the same endpoint for every API; scope determines what you get.
 */
export const YOUTUBE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * OAuth 2.0 token endpoint.
 *
 * Short-lived access token exchange and refresh-token grant both hit this URL.
 */
export const YOUTUBE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * YouTube Data API v3 base.
 *
 * Used for channel metadata and content details (e.g. duration for Shorts check).
 */
export const YOUTUBE_DATA_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * YouTube Analytics API v2 base.
 *
 * Used for settlement metrics (views, engagedViews, etc.).
 *
 * Note the hostname: `youtubeanalytics.googleapis.com`, not
 * `www.googleapis.com`.
 */
export const YOUTUBE_ANALYTICS_API_BASE = 'https://youtubeanalytics.googleapis.com/v2';

/**
 * The minimum set for socialbucks.
 *
 * `youtube.readonly` covers:
 *   - Channel metadata (snippet, contentDetails, statistics)
 *   - Video list and details
 *   - PlaylistItems
 *
 * `yt-analytics.readonly` covers:
 *   - All YouTube Analytics reports (the settlement job)
 *
 * Deliberately excludes upload, comment, and playlist modification scopes:
 * creators submit a URL, we never need to write on their behalf.
 */
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
] as const;

/**
 * AAD for the token ciphertext. Changing this string makes every existing
 * row undecryptable, so treat it as part of the storage format.
 *
 * YouTube refresh tokens are stored encrypted in SocialAccount.tokenCiphertext.
 */
export const TOKEN_ENCRYPTION_CONTEXT = 'youtube:refresh_token:v1';

/**
 * Returns the app origin derived from YOUTUBE_REDIRECT_URI.
 *
 * This is a **lazy getter** rather than a module-level constant so that
 * importing this file (e.g. from analytics.ts) does not trigger
 * envSchema.parse() at test time when secrets are absent.
 *
 * Call this only in request-handling code (callback routes, buildAuthorizeUrl),
 * never at module-load time.
 */
export function getAppOrigin(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require('@/lib/env') as { env: { YOUTUBE_REDIRECT_URI: string } };
  return new URL(env.YOUTUBE_REDIRECT_URI).origin;
}

/**
 * Where the user ends up after connecting. Kept here so the callback and
 * any future disconnect route agree.
 */
export const CONNECT_RETURN_PATH = '/dashboard';