// TARGET PATH: apps/web/src/app/api/auth/instagram/verify/route.ts
//
// "Is the connection actually working?" as a JSON endpoint.
//
// Scoped hard to the caller's own connection — it takes no parameters at
// all, so there is nothing to tamper with and no way to probe another
// creator's account. That is deliberate: the obvious design (accept a
// creatorId) would be an enumeration hole.
//
// Returns 200 even when checks fail. The HTTP status describes whether the
// *check ran*; `ok` in the body describes whether the connection is healthy.
// Collapsing those two into one status code makes the failure ambiguous.

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

import { runInstagramHealthCheck } from '@/lib/instagram/connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await runInstagramHealthCheck(userId);

    console.info('[instagram] health check', {
      clerkUserId: userId,
      ok: report.ok,
      failed: report.steps
        .filter((step) => step.status === 'fail')
        .map((step) => step.name),
    });

    return NextResponse.json(report, {
      // Never let a browser or proxy cache a health check.
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[instagram] health check crashed', {
      clerkUserId: userId,
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : undefined,
    });
    return NextResponse.json({ error: 'Health check failed' }, { status: 500 });
  }
}
