// TARGET PATH: apps/web/src/lib/env.ts
//
// Validates required env vars at boot instead of failing silently the
// first time a request needs a missing key. Import `env` instead of
// reading `process.env` directly anywhere auth is involved.

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

const envSchema = z.object({
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
});

export const env = envSchema.parse({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
  INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET: process.env.INSTAGRAM_APP_SECRET,
  INSTAGRAM_REDIRECT_URI: process.env.INSTAGRAM_REDIRECT_URI,
  INSTAGRAM_TOKEN_ENCRYPTION_KEY: process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY,
  META_APP_SECRET: process.env.META_APP_SECRET,
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI,
  YOUTUBE_TOKEN_ENCRYPTION_KEY: process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY,
});
