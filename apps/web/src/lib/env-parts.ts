// apps/web/src/lib/env-parts.ts
//
// The per-variable environment rules, plus the lazy accessors the settlement
// path needs.
//
// Why this module exists: env.ts parses ALL of the app's variables at import, so
// any module that reached env.ts could only be loaded by a process holding every
// Clerk and Instagram credential. The settlement path (lib/crypto/secret-box and
// lib/youtube/oauth) needs four YouTube variables; the worker that runs
// settlement holds exactly those (ADR-0006 D8). Those modules therefore read
// their values from here, lazily, and a process can import them with nothing but
// YouTube settings.
//
// Two entry points, one rule per variable:
//   - env.ts composes every rule in `envParts` and parses at import, so the web
//     app still refuses to boot on any missing or malformed value;
//   - the accessors below validate only what they are asked for, at the moment
//     they are asked, and `parseSettlementEnv` is the strict preflight for the
//     settlement process.
//
// This file must never import env.ts: env.ts imports this one.

import { z } from 'zod';

/**
 * `Buffer.from(value, 'base64')` silently discards characters it doesn't
 * recognize, so a truncated or whitespace-mangled paste can still yield a
 * 32-byte buffer. Shape-check the string before trusting its length, or
 * we ship an encryption key nobody can reproduce from the original value.
 */
function isBase64OfExactBytes(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === bytes;
}

/**
 * One rule per variable, moved here verbatim from env.ts: same refinements, same
 * messages. Each rule exists exactly once, so the web app and the settlement
 * path cannot drift apart.
 */
export const envParts = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .min(1, 'Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'),
  CLERK_SECRET_KEY: z.string().min(1, 'Missing CLERK_SECRET_KEY'),
  // Optional until you wire the webhook in step 8 — but once you do,
  // add .min(1, ...) here too so a missing secret fails the build.
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),

  // Instagram API with Instagram Login. Note these are the *Instagram*
  // app credentials from the Instagram product's business login settings,
  // not the Meta app ID/secret on the top-level Basic settings page.
  INSTAGRAM_APP_ID: z.string().min(1, 'Missing INSTAGRAM_APP_ID'),
  INSTAGRAM_APP_SECRET: z.string().min(1, 'Missing INSTAGRAM_APP_SECRET'),

  // Meta compares redirect_uri byte-for-byte against the dashboard entry,
  // so the two most common failures — a non-HTTPS origin and a stray
  // trailing slash — are worth failing the boot over rather than
  // debugging through an opaque OAuth error later.
  INSTAGRAM_REDIRECT_URI: z
    .string()
    .startsWith('https://', 'Meta rejects non-HTTPS redirect URIs')
    .refine(
      (value) => URL.canParse(value),
      'INSTAGRAM_REDIRECT_URI must be an absolute URL',
    )
    .refine(
      (value) => !value.endsWith('/'),
      'Drop the trailing slash — Meta compares redirect_uri byte-for-byte',
    ),

  INSTAGRAM_TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => isBase64OfExactBytes(value, 32),
      'INSTAGRAM_TOKEN_ENCRYPTION_KEY must be base64 decoding to exactly 32 bytes (openssl rand -base64 32)',
    ),

  // Only needed if Meta signs the deauthorize / data-deletion callbacks
  // with the top-level Meta app secret rather than the Instagram one.
  // See signed-request.ts — we accept either, and this lets you drop the
  // ambiguity once you've confirmed which one your app actually sends.
  META_APP_SECRET: z.string().optional(),

  // --- YouTube Data API v3 / OAuth 2.0 ---------------------------------------
  YOUTUBE_CLIENT_ID: z.string().min(1, 'Missing YOUTUBE_CLIENT_ID'),
  YOUTUBE_CLIENT_SECRET: z.string().min(1, 'Missing YOUTUBE_CLIENT_SECRET'),

  // Google compares redirect_uri byte-for-byte against the Cloud Console entry,
  // same failure modes as Instagram: non-HTTPS and trailing slashes.
  YOUTUBE_REDIRECT_URI: z
    .string()
    .startsWith('https://', 'Google rejects non-HTTPS redirect URIs')
    .refine(
      (value) => URL.canParse(value),
      'YOUTUBE_REDIRECT_URI must be an absolute URL',
    )
    .refine(
      (value) => !value.endsWith('/'),
      'Drop the trailing slash — Google compares redirect_uri byte-for-byte',
    ),

  // Separate AES-256-GCM key for youtubeTokenCiphertext. Keeping it distinct
  // from INSTAGRAM_TOKEN_ENCRYPTION_KEY means a ciphertext leak on one platform
  // does not compromise the other.
  YOUTUBE_TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => isBase64OfExactBytes(value, 32),
      'YOUTUBE_TOKEN_ENCRYPTION_KEY must be base64 decoding to exactly 32 bytes (openssl rand -base64 32)',
    ),
};

// ---------------------------------------------------------------------------
// Lazy accessors for the settlement path
// ---------------------------------------------------------------------------

/**
 * Reads one variable and validates it on the spot.
 *
 * Absent (or empty) yields undefined: a settlement process may legitimately have
 * no Instagram credential, and "not configured" is the caller's decision to act
 * on. A malformed *present* value throws that variable's ZodError - whose
 * messages name the variable and never contain the value, because every rule
 * above uses a fixed message.
 *
 * Nothing here is cached: a test can change process.env and re-read.
 */
function readOptional(name: string, rule: z.ZodType): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  rule.parse(raw);
  return raw;
}

/**
 * The two platform encryption keys.
 *
 * Read lazily so that importing secret-box does not require the variables to be
 * present: a worker imports settlement code at boot and validates the
 * environment in its own preflight (see parseSettlementEnv).
 */
export const tokenKeys = {
  get instagram(): string | undefined {
    return readOptional('INSTAGRAM_TOKEN_ENCRYPTION_KEY', envParts.INSTAGRAM_TOKEN_ENCRYPTION_KEY);
  },
  get youtube(): string | undefined {
    return readOptional('YOUTUBE_TOKEN_ENCRYPTION_KEY', envParts.YOUTUBE_TOKEN_ENCRYPTION_KEY);
  },
};

/** The three YouTube OAuth settings, read lazily, same rules as the web app. */
export const youtubeOAuth = {
  get clientId(): string | undefined {
    return readOptional('YOUTUBE_CLIENT_ID', envParts.YOUTUBE_CLIENT_ID);
  },
  get clientSecret(): string | undefined {
    return readOptional('YOUTUBE_CLIENT_SECRET', envParts.YOUTUBE_CLIENT_SECRET);
  },
  get redirectUri(): string | undefined {
    return readOptional('YOUTUBE_REDIRECT_URI', envParts.YOUTUBE_REDIRECT_URI);
  },
};

// ---------------------------------------------------------------------------
// Strict preflight for the settlement process
// ---------------------------------------------------------------------------

/**
 * What settlement needs: the four YouTube variables, and an Instagram key only
 * if one happens to be configured.
 *
 * The Instagram key is optional because the worker never talks to Instagram, but
 * if it is present it is held to the same rule as in the web app, and it must
 * not equal the YouTube key: one key per platform is what stops a leak or a
 * rotation on one platform from silently affecting the other.
 */
const settlementEnvSchema = z
  .object({
    YOUTUBE_CLIENT_ID: envParts.YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET: envParts.YOUTUBE_CLIENT_SECRET,
    YOUTUBE_REDIRECT_URI: envParts.YOUTUBE_REDIRECT_URI,
    YOUTUBE_TOKEN_ENCRYPTION_KEY: envParts.YOUTUBE_TOKEN_ENCRYPTION_KEY,
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: envParts.INSTAGRAM_TOKEN_ENCRYPTION_KEY.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.INSTAGRAM_TOKEN_ENCRYPTION_KEY === undefined) return;

    // Compared as decoded bytes, exactly as secret-box compares them: two
    // different base64 spellings of the same 32 bytes are the same key, and a
    // raw-string comparison would let that through.
    const instagramKey = Buffer.from(value.INSTAGRAM_TOKEN_ENCRYPTION_KEY, 'base64');
    const youtubeKey = Buffer.from(value.YOUTUBE_TOKEN_ENCRYPTION_KEY, 'base64');
    if (instagramKey.equals(youtubeKey)) {
      ctx.addIssue({
        code: 'custom',
        path: ['YOUTUBE_TOKEN_ENCRYPTION_KEY'],
        message: 'YOUTUBE_TOKEN_ENCRYPTION_KEY must differ from INSTAGRAM_TOKEN_ENCRYPTION_KEY (one key per platform)',
      });
    }
  });

export type SettlementEnv = z.infer<typeof settlementEnvSchema>;

/**
 * Validates the settlement environment and returns the values, or throws a
 * ZodError whose issues name variables and never values.
 *
 * Deliberately strict about emptiness: this is the boot-time gate, so a cleared
 * field (`INSTAGRAM_TOKEN_ENCRYPTION_KEY=`) is reported as a malformed key
 * rather than quietly ignored.
 */
export function parseSettlementEnv(
  source: Record<string, string | undefined>,
): SettlementEnv {
  return settlementEnvSchema.parse(source);
}
