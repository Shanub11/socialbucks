// TARGET PATH: apps/web/src/lib/env.ts
//
// Validates required env vars at boot instead of failing silently the
// first time a request needs a missing key. Import `env` instead of
// reading `process.env` directly anywhere auth is involved.

import { z } from 'zod';

const envSchema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .min(1, 'Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'),
  CLERK_SECRET_KEY: z.string().min(1, 'Missing CLERK_SECRET_KEY'),
  // Optional until you wire the webhook in step 8 — but once you do,
  // add .min(1, ...) here too so a missing secret fails the build.
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),
});

export const env = envSchema.parse({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
});
