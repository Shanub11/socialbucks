// TARGET PATH: apps/web/src/lib/instagram/oauth.ts
//
// Server-only wrappers around the Instagram OAuth token endpoints and the
// /me profile read. Every function here handles a *secret*, so:
//
//   - nothing in this file logs a token, a code, or the app secret;
//   - every response is parsed through zod rather than trusted, because
//     these are untrusted external payloads and Meta has changed field
//     types between versions (user_id has been both string and number,
//     permissions both array and comma-joined string);
//   - every request has an explicit timeout, so a hung Meta endpoint can't
//     pin a route handler open indefinitely.
//
// Must run on the nodejs runtime — it reads the app secret.

import { z } from 'zod';

import { env } from '@/lib/env';
import {
  INSTAGRAM_AUTHORIZE_URL,
  INSTAGRAM_GRAPH_BASE,
  INSTAGRAM_TOKEN_URL,
  REQUIRED_SCOPES,
} from '@/lib/instagram/constants';

const REQUEST_TIMEOUT_MS = 10_000;

export class InstagramOAuthError extends Error {
  readonly status: number | undefined;
  /** Meta's error code, when it sends one. Safe to log. */
  readonly metaCode: string | undefined;

  constructor(
    message: string,
    options: { status?: number; metaCode?: string } = {},
  ) {
    super(message);
    this.name = 'InstagramOAuthError';
    this.status = options.status;
    this.metaCode = options.metaCode;
  }
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */

/** Meta has shipped this as both a number and a numeric string. */
const idLike = z.union([z.string(), z.number()]).transform(String);

/** And this as both an array and a comma-joined string. */
const permissionList = z
  .union([z.array(z.string()), z.string()])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  );

const shortLivedTokenSchema = z.object({
  access_token: z.string().min(1),
  user_id: idLike,
  permissions: permissionList.optional(),
});

const longLivedTokenSchema = z.object({
  access_token: z.string().min(1),
  /** Seconds. Roughly 60 days. */
  expires_in: z.number().int().positive(),
});

const profileSchema = z.object({
  id: idLike.optional(),
  user_id: idLike.optional(),
  username: z.string().min(1),
  account_type: z.string().optional(),
  media_count: z.number().int().nonnegative().optional(),
});

/** Meta's error envelope, used only to surface a safe code in logs. */
const metaErrorSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      type: z.string().optional(),
      code: z.union([z.string(), z.number()]).optional(),
      error_subcode: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
  error_type: z.string().optional(),
  error_message: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface ShortLivedToken {
  accessToken: string;
  instagramUserId: string;
  grantedScopes: string[];
}

export interface LongLivedToken {
  accessToken: string;
  expiresAt: Date;
}

export interface InstagramProfile {
  instagramUserId: string;
  username: string;
  /** Raw value from Meta; normalize with mapAccountType before storing. */
  rawAccountType: string | undefined;
  mediaCount: number | undefined;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InstagramOAuthError('Meta returned a non-JSON response', {
      status: response.status,
    });
  }
}

/**
 * Turns a non-2xx into an InstagramOAuthError carrying only Meta's own
 * error code and type. Meta's `message` can echo request parameters back,
 * so it is deliberately not propagated into the thrown message.
 */
function throwForStatus(response: Response, body: unknown): never {
  const parsed = metaErrorSchema.safeParse(body);
  const code = parsed.success
    ? String(parsed.data.error?.code ?? parsed.data.error_type ?? 'unknown')
    : 'unparseable';
  const type = parsed.success
    ? (parsed.data.error?.type ?? parsed.data.error_type)
    : undefined;

  throw new InstagramOAuthError(
    `Instagram API rejected the request (${type ?? 'error'} / code ${code})`,
    { status: response.status, metaCode: code },
  );
}

/**
 * Exported so `media.ts` reuses the same hardening (timeout, no-store,
 * non-JSON guard, safe error surfacing) instead of re-implementing it.
 * Treat as internal to lib/instagram — routes should not call it directly.
 */
export async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    throw new InstagramOAuthError(
      timedOut
        ? 'Instagram API request timed out'
        : 'Instagram API request failed to connect',
    );
  }

  const body = await readJson(response);
  if (!response.ok) throwForStatus(response, body);
  return body;
}

/** Exported for `media.ts`. See the note on `requestJson`. */
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  body: unknown,
  label: string,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    // Log the *shape* only. The body contains a live token.
    console.error(`[instagram] unexpected ${label} response shape`, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
    throw new InstagramOAuthError(`Unexpected ${label} response from Meta`);
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function buildAuthorizeUrl(state: string): string {
  const url = new URL(INSTAGRAM_AUTHORIZE_URL);
  url.searchParams.set('client_id', env.INSTAGRAM_APP_ID);
  url.searchParams.set('redirect_uri', env.INSTAGRAM_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', REQUIRED_SCOPES.join(','));
  url.searchParams.set('state', state);
  // Creators authenticate with Instagram credentials; offering the Facebook
  // option here only invites the Page-linked variant's problems.
  url.searchParams.set('enable_fb_login', 'false');
  return url.toString();
}

/**
 * Authorization codes are single-use and expire in one hour. Do not wrap
 * this in a retry — a second attempt with the same code always fails, and
 * you'll misread it as a credential problem.
 */
export async function exchangeCodeForShortLivedToken(
  code: string,
): Promise<ShortLivedToken> {
  const body = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    client_secret: env.INSTAGRAM_APP_SECRET,
    grant_type: 'authorization_code',
    // Meta requires this again here, and re-compares it byte-for-byte
    // against the value used at authorize time.
    redirect_uri: env.INSTAGRAM_REDIRECT_URI,
    code,
  });

  const json = await requestJson(INSTAGRAM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const parsed = parseOrThrow(shortLivedTokenSchema, json, 'token exchange');

  return {
    accessToken: parsed.access_token,
    instagramUserId: parsed.user_id,
    grantedScopes: parsed.permissions ?? [],
  };
}

/** Short-lived tokens live one hour. Upgrade immediately; never persist one. */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
): Promise<LongLivedToken> {
  const url = new URL('/access_token', INSTAGRAM_GRAPH_BASE);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', env.INSTAGRAM_APP_SECRET);
  url.searchParams.set('access_token', shortLivedToken);

  const parsed = parseOrThrow(
    longLivedTokenSchema,
    await requestJson(url.toString()),
    'long-lived token exchange',
  );

  return {
    accessToken: parsed.access_token,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
  };
}

/**
 * For the refresh cron. Meta requires the token to be at least 24 hours
 * old, still unexpired, and still carrying instagram_business_basic.
 */
export async function refreshLongLivedToken(
  longLivedToken: string,
): Promise<LongLivedToken> {
  const url = new URL('/refresh_access_token', INSTAGRAM_GRAPH_BASE);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', longLivedToken);

  const parsed = parseOrThrow(
    longLivedTokenSchema,
    await requestJson(url.toString()),
    'token refresh',
  );

  return {
    accessToken: parsed.access_token,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
  };
}

/**
 * Reads the profile via `/me` rather than `/<id>`. The Instagram User node
 * exposes both `id` and `user_id` and they are not interchangeable across
 * the two login variants; `me` sidesteps the ambiguity entirely, and we
 * store whichever identifier Meta gives us for dedup only.
 */
export async function fetchInstagramProfile(
  accessToken: string,
): Promise<InstagramProfile> {
  const url = new URL('/me', INSTAGRAM_GRAPH_BASE);
  url.searchParams.set(
    'fields',
    ['id', 'user_id', 'username', 'account_type', 'media_count'].join(','),
  );
  url.searchParams.set('access_token', accessToken);

  const parsed = parseOrThrow(
    profileSchema,
    await requestJson(url.toString()),
    'profile',
  );

  const instagramUserId = parsed.user_id ?? parsed.id;
  if (!instagramUserId) {
    throw new InstagramOAuthError('Profile response carried no usable user id');
  }

  return {
    instagramUserId,
    username: parsed.username,
    rawAccountType: parsed.account_type,
    mediaCount: parsed.media_count,
  };
}

/**
 * Users can decline individual scopes on the consent screen, and Meta will
 * still hand back a valid token. Without this check the connection looks
 * successful and then every insights call 403s days later.
 */
export function findMissingScopes(grantedScopes: string[]): string[] {
  if (grantedScopes.length === 0) {
    // Some API versions omit `permissions` entirely. Treat that as
    // "unknown, not empty" — the insights call will tell us for real.
    return [];
  }
  return REQUIRED_SCOPES.filter((scope) => !grantedScopes.includes(scope));
}
