// TARGET PATH: apps/web/src/lib/auth/ensure-user.ts
//
// Safety net for User row provisioning.
//
// The Clerk webhook is the primary path and stays the primary path — it is
// the only thing that can deliver user.updated and user.deleted. But
// depending on it for *creation* means any dropped delivery, stale endpoint
// URL, or rotated tunnel produces a signed-in user with no row, and the
// symptom surfaces several steps downstream (an Instagram connection that
// completes the entire OAuth dance and then fails at the final insert).
//
// So: creation is idempotent and can also happen on demand. Called from the
// places that actually need a row to exist, not from requireAuth() — the
// auth boundary should stay a pure authorization check with no writes.
//
// Deliberately does NOT refresh email/name on an existing row. That is the
// webhook's job; racing it here would let a stale read overwrite a fresh
// update.

import { clerkClient } from '@clerk/nextjs/server';
import { prisma } from '@repo/database';

export type ProvisionResult =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; reason: 'soft_deleted' | 'clerk_lookup_failed' };

export async function ensureUserProvisioned(
  clerkUserId: string,
): Promise<ProvisionResult> {
  const existing = await prisma.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { id: true, deletedAt: true },
  });

  if (existing) {
    // A soft-deleted user must not be silently resurrected by simply
    // signing in again — that is a decision for an explicit reinstate
    // flow, not a side effect of a page load.
    return existing.deletedAt
      ? { ok: false, reason: 'soft_deleted' }
      : { ok: true, userId: existing.id, created: false };
  }

  let email = '';
  let firstName: string | null = null;
  let lastName: string | null = null;

  try {
    const client = await clerkClient();
    const clerkUser = await client.users.getUser(clerkUserId);

    // Same selection logic as the webhook handler, so a row created here is
    // indistinguishable from one created by a delivery.
    email =
      clerkUser.emailAddresses.find(
        (address) => address.id === clerkUser.primaryEmailAddressId,
      )?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress ??
      '';
    firstName = clerkUser.firstName ?? null;
    lastName = clerkUser.lastName ?? null;
  } catch (error) {
    // Clerk's Backend API is the only trustworthy source for the email —
    // the session token doesn't carry it unless the JWT template is
    // customised. Without it, don't invent a row.
    console.error('[auth] Clerk user lookup failed during provisioning', {
      clerkUserId,
      message: error instanceof Error ? error.message : undefined,
    });
    return { ok: false, reason: 'clerk_lookup_failed' };
  }

  try {
    const created = await prisma.user.create({
      data: { clerkId: clerkUserId, email, firstName, lastName },
      select: { id: true },
    });

    console.info('[auth] provisioned User row on demand', {
      clerkUserId,
      userId: created.id,
    });

    return { ok: true, userId: created.id, created: true };
  } catch (error) {
    // Either a concurrent request won the race, or the webhook landed
    // between our read and our write. The unique index on clerkId is what
    // makes that safe; re-read rather than treating it as a failure.
    const raced = await prisma.user.findUnique({
      where: { clerkId: clerkUserId },
      select: { id: true, deletedAt: true },
    });

    if (raced && !raced.deletedAt) {
      return { ok: true, userId: raced.id, created: false };
    }

    throw error;
  }
}
