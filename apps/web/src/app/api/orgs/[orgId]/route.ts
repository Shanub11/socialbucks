// apps/web/src/app/api/orgs/[orgId]/route.ts
//
// GET /api/orgs/[orgId] — read one organization. Any member (OWNER, ADMIN,
// MEMBER) may read; writes are gated per route by requireOrgRole.
//
// Non-member, unknown id, soft-deleted org and malformed id are all the same
// 404 so the endpoint cannot be used to probe which organization ids exist.

import { prisma } from '@repo/database';

import {
  getOrgAccess,
  orgAccessErrorResponse,
  provisionedUserOrResponse,
} from '@/lib/auth/org-access';
import { requireAuthApi } from '@/lib/auth/require-auth';
import { noStoreJson } from '@/lib/http/json';
import { OrgIdParamSchema } from '@/lib/orgs/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const authResult = await requireAuthApi();
    if (!authResult.ok) return authResult.response;

    // This version of Next.js passes route params as a Promise.
    const { orgId } = await params;

    const parsed = OrgIdParamSchema.safeParse(orgId);
    if (!parsed.success) return orgAccessErrorResponse('NOT_FOUND');

    const user = await provisionedUserOrResponse(authResult.userId);
    if (!user.ok) return user.response;

    const access = await getOrgAccess(user.userId, parsed.data);
    if (!access.ok) return orgAccessErrorResponse(access.reason);

    const org = await prisma.organization.findUnique({
      where: { id: access.organizationId },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    if (!org) return orgAccessErrorResponse('NOT_FOUND');

    return noStoreJson({
      id: org.id,
      name: org.name,
      role: access.role,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
    });
  } catch (error) {
    console.error('[orgs] get organization failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
