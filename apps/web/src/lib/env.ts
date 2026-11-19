// TARGET PATH: apps/web/src/lib/env.ts
//
// Validates required env vars at boot instead of failing silently the
// first time a request needs a missing key. Import `env` instead of
// reading `process.env` directly anywhere auth is involved.
//
// The rules themselves live in env-parts.ts, one per variable, shared with the
// settlement path - which has to import its modules holding only YouTube
// settings (ADR-0006 D8). This file composes all of them and parses once, at
// import, so a web process still refuses to boot on any missing or malformed
// value, with the same errors and the same same-key check as before the split.

import { z } from 'zod';

import { envParts } from './env-parts';

/**
 * The full schema: every variable, plus the cross-platform key check.
 *
 * Exported so the parity test can run the same values through the composed
 * schema it actually boots with, rather than through a copy of it.
 */
export const envSchema = z.object(envParts).superRefine((value, ctx) => {
  // Both platforms on one key would let a leak or a rotation on one silently affect the other.
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
