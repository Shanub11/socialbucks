// TARGET PATH: apps/web/src/proxy.ts
//
// Next.js 16's network-boundary file (formerly middleware.ts).
//
// SECURITY NOTE (CVE-2025-29927 lesson): this file only attaches Clerk's
// session to the request so `auth()` resolves elsewhere in the app. It
// does NOT decide who can access what. Route interception at this layer
// has been bypassable before in this class of framework (a spoofed
// x-middleware-subrequest header let attackers skip middleware entirely
// in versions before 15.2.3) — so treat this as a UX convenience, not
// the security boundary. The real check lives in require-auth.ts, called
// from the Server Components and Route Handlers that actually touch data.
//
// Do not add auth.protect() / route-matcher gating logic here.

import { clerkMiddleware } from '@clerk/nextjs/server';

export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and static assets
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
    // Always run for Clerk's own frontend API routes
    '/__clerk/(.*)',
  ],
};
