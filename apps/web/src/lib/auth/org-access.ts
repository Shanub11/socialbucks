// TARGET PATH: apps/web/src/lib/auth/org-access.ts
//
// Shared organization-access helper for the campaign product API (Part 1).
//
// Patterns:
// - getOrgAccess(userId, organizationId): DB-only (userId already resolved
//   through requireAuthApi + ensureUserProvisioned in the calling route).
// - requireOrgRole(access, allowedRoles): validates role allowance.
// - orgAccessErrorResponse(reason): maps reason to status + JSON error body.
// - provisionedUserOrResponse(clerkUserId): resolves Clerk provisioning with
//   mapped HTTP responses, does NOT include reason in the response body.

import { prisma, OrganizationRole } from '@repo/database';
import { NextResponse } from 'next/server';
import { ensureUserProvisioned } from '@/lib/auth/ensure-user';

export const ORG_MANAGER_ROLES: readonly OrganizationRole[] = [OrganizationRole.OWNER, OrganizationRole.ADMIN];

/** User resolved as a member of a live organization, with their real role. */
export type OrgAccessGranted = {
  ok: true;
  userId: string;
  organizationId: string;
  role: OrganizationRole;
};

/**
 * Why access was denied. Deliberately coarse: the caller is not told which of
 * unknown-org / soft-deleted-org / non-member applied (see getOrgAccess).
 */
export type OrgAccessDenied = { ok: false; reason: 'NOT_FOUND' | 'FORBIDDEN' };

/** Discriminated union: user has org access OR access is denied. */
export type OrgAccess = OrgAccessGranted | OrgAccessDenied;

/**
 * DB-only: checks whether a user belongs to an organization and returns
 * their role — or NOT_FOUND for ALL of: unknown org, soft-deleted org,
 * and a user who is not a member. Outcomes are intentionally identical so
 * org ids cannot be probed.
 */
export async function getOrgAccess(
  userId: string,
  organizationId: string,
): Promise<OrgAccess> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, deletedAt: true },
  });

  if (!org || org.deletedAt) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  const membership = await prisma.organizationMember.findFirst({
    // Deliberately NOT filtered by role: every member of a live organization
    // resolves here with their real role, and each handler decides whether
    // that role may write. Filtering by manager role here made a MEMBER
    // indistinguishable from a non-member (404), breaking the read path.
    where: { organizationId, userId },
    select: { role: true },
  });

  if (!membership) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  return { ok: true, userId, organizationId, role: membership.role };
}

/** Allow / deny a role against an access result. */
export function requireOrgRole(
  access: OrgAccess,
  allowedRoles: readonly OrganizationRole[],
): OrgAccess {
  if (!access.ok) {
    return access;
  }
  if (allowedRoles.includes(access.role)) {
    return access;
  }
  return { ok: false, reason: 'FORBIDDEN' };
}

/** Map a denial reason to the shared 404 / 403 error shapes. */
export function orgAccessErrorResponse(
  reason: OrgAccessDenied['reason'],
): NextResponse {
  if (reason === 'NOT_FOUND') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

/**
 * Calls ensureUserProvisioned(clerkUserId) and maps outcomes to HTTP
 * responses, never returning the `reason` field inside a response body.
 *
 * Mapping:
 *   ok        -> { ok: true, userId: internalUserId }  (caller uses it)
 *   soft_deleted  -> 403 { error: 'Account disabled' }
 *   clerk_lookup_failed -> 503 { error: 'Service temporarily unavailable' }
 *
 * Guarantee: the returned NextResponse always omits a `reason` key.
 */
export async function provisionedUserOrResponse(
  clerkUserId: string,
): Promise<
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse }
> {
  const result = await ensureUserProvisioned(clerkUserId);

  if (result.ok) {
    return { ok: true, userId: result.userId };
  }

  if (result.reason === 'soft_deleted') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Account disabled' },
        { status: 403 },
      ),
    };
  }

  return {
    ok: false,
    response: NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 503 },
    ),
  };
}