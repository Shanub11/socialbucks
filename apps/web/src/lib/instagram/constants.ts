// TARGET PATH: apps/web/src/lib/instagram/constants.ts
//
// Endpoints, scopes, and derived origins for Instagram API with Instagram
// Login. Kept separate from oauth.ts so the values are greppable and there
// is exactly one place to touch when Meta moves a host.

import { env } from '@/lib/env';

/** Note the host: authorization happens on instagram.com, not facebook.com. */
export const INSTAGRAM_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';

/** Short-lived token exchange. Different host again — api.instagram.com. */
export const INSTAGRAM_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';

/** Everything else — long-lived exchange, refresh, and all data reads. */
export const INSTAGRAM_GRAPH_BASE = 'https://graph.instagram.com';

/**
 * The minimum set for socialbucks. `instagram_business_basic` covers the
 * profile and media list; `instagram_business_manage_insights` is what
 * authorizes GET /<media-id>/insights, which is the only source for the
 * reel `views` figure that drives CampaignCreatorSlot milestone tiers.
 *
 * Deliberately excludes content_publish, manage_comments, and
 * manage_messages: creators post their own content and submit a URL, so
 * asking for more would be extra App Review surface and a longer consent
 * screen for no functional gain.
 */
export const REQUIRED_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_insights',
] as const;

/**
 * AAD for the token ciphertext. Changing this string makes every existing
 * row undecryptable, so treat it as part of the storage format.
 */
export const TOKEN_ENCRYPTION_CONTEXT = 'instagram:long_lived_access_token:v1';

/**
 * Derived from the redirect URI rather than configured separately, which
 * guarantees post-callback redirects land on the same origin the OAuth
 * flow returned to. Two env vars that must agree is two env vars that
 * eventually won't.
 */
export const APP_ORIGIN = new URL(env.INSTAGRAM_REDIRECT_URI).origin;

/**
 * Where the user ends up after connecting. Kept here so the callback and
 * any future disconnect route agree.
 */
export const CONNECT_RETURN_PATH = '/dashboard';

/** Long-lived tokens last 60 days; refresh well before the edge. */
export const TOKEN_REFRESH_THRESHOLD_DAYS = 10;
