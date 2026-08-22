// TARGET PATH: apps/web/src/lib/auth/require-auth.ts
//
// This is the real authorization check for CPX. Call it at the top of
// every Server Component, Route Handler, or Server Action that reads or
// writes protected data. proxy.ts attaches the session; this is what
// actually enforces it.

import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';

/**
 * Use in Server Components / Server Actions, where redirecting an
 * anonymous user to /sign-in is the right behavior.
 *
 *   const { userId } = await requireAuth();
 */
export async function requireAuth() {
  const { userId, sessionClaims } = await auth();

  if (!userId) {
    redirect('/sign-in');
  }

  return { userId, sessionClaims };
}

/**
 * Use in Route Handlers, where you want a 401 JSON response instead of a
 * redirect. Returns a discriminated union so TypeScript forces you to
 * handle the unauthenticated case before touching `userId`.
 *
 *   export async function POST(req: Request) {
 *     const result = await requireAuthApi();
 *     if (!result.ok) return result.response;
 *     const { userId } = result;
 *     ...
 *   }
 */
export async function requireAuthApi() {
  const { userId, sessionClaims } = await auth();

  if (!userId) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return { ok: true as const, userId, sessionClaims };
}
