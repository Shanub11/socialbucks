// TARGET PATH: apps/web/src/app/api/me/route.ts
// (replaces the earlier version — this one actually imports and queries
// @repo/database, which is what exercises the Turbopack/Prisma 7 risk.
// The earlier version never touched Prisma, so it couldn't have caught it.)

import { requireAuthApi } from '@/lib/auth/require-auth';
import { prisma } from '@repo/database';
import { NextResponse } from 'next/server';

export async function GET() {
  const result = await requireAuthApi();
  if (!result.ok) return result.response;

  // A real query. If the module-resolution issue is going to show up,
  // it shows up here — not in a typecheck.
  const user = await prisma.user.findUnique({
    where: { clerkId: result.userId },
  });

  return NextResponse.json({ clerkUserId: result.userId, dbUser: user });
}