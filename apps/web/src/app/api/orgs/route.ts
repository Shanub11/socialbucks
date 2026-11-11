// apps/web/src/app/api/orgs/route.ts
//
// POST /api/orgs — create an organization owned by the caller.
// GET  /api/orgs — list the caller's live organizations (cursor paginated).
//
// Both handlers authenticate first, validate the request before touching the
// database, and never return a raw Prisma row.

import { OrganizationRole, prisma } from '@repo/database';

import { provisionedUserOrResponse } from '@/lib/auth/org-access';
import { requireAuthApi } from '@/lib/auth/require-auth';
import { noStoreJson, parseJsonBody, parseQuery } from '@/lib/http/json';
import { DEFAULT_PAGE_SIZE, MAX_OWNED_ORGS_PER_USER } from '@/lib/orgs/constants';
import { CreateOrgBodySchema, ListOrgsQuerySchema } from '@/lib/orgs/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CreateOrgOutcome =
  | { kind: 'limit' }
  | { kind: 'created'; org: { id: string; name: string; createdAt: Date } };

export async function POST(req: Request) {
  try {
    const authResult = await requireAuthApi();
    if (!authResult.ok) return authResult.response;

    // Validate before provisioning: an invalid body must not be able to create
    // a User row (or anything else) as a side effect.
    const body = await parseJsonBody(req, CreateOrgBodySchema);
    if (!body.ok) return body.response;

    const user = await provisionedUserOrResponse(authResult.userId);
    if (!user.ok) return user.response;

    const outcome = await prisma.$transaction(
      async (tx): Promise<CreateOrgOutcome> => {
        const ownedCount = await tx.organizationMember.count({
          where: {
            userId: user.userId,
            role: OrganizationRole.OWNER,
            organization: { deletedAt: null },
          },
        });

        // Soft abuse guard, deliberately NOT race-safe: two concurrent requests
        // can both read ownedCount = MAX - 1 and both create. Real rate limiting
        // belongs at the edge; this only stops trivial scripted abuse.
        if (ownedCount >= MAX_OWNED_ORGS_PER_USER) {
          return { kind: 'limit' };
        }

        const org = await tx.organization.create({
          // clerkOrgId is intentionally never set by this API.
          data: { name: body.data.name },
          select: { id: true, name: true, createdAt: true },
        });

        await tx.organizationMember.create({
          data: {
            organizationId: org.id,
            userId: user.userId,
            role: OrganizationRole.OWNER,
          },
          select: { id: true },
        });

        return { kind: 'created', org };
      },
    );

    if (outcome.kind === 'limit') {
      return noStoreJson(
        { error: 'Organization limit reached', code: 'ORG_LIMIT_REACHED' },
        409,
      );
    }

    return noStoreJson(
      {
        id: outcome.org.id,
        name: outcome.org.name,
        role: OrganizationRole.OWNER,
        createdAt: outcome.org.createdAt,
      },
      201,
    );
  } catch (error) {
    console.error('[orgs] create organization failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}

export async function GET(req: Request) {
  try {
    const authResult = await requireAuthApi();
    if (!authResult.ok) return authResult.response;

    const query = parseQuery(req, ListOrgsQuerySchema);
    if (!query.ok) return query.response;

    const user = await provisionedUserOrResponse(authResult.userId);
    if (!user.ok) return user.response;

    const limit = query.data.limit ?? DEFAULT_PAGE_SIZE;
    const cursor = query.data.cursor;

    if (cursor !== undefined) {
      // The cursor is a membership id, so it must belong to the caller. Without
      // this check a foreign cursor would position the page inside another
      // user's data (and leak whether that row exists).
      const cursorRow = await prisma.organizationMember.findFirst({
        where: { id: cursor, userId: user.userId },
        select: { id: true },
      });
      if (!cursorRow) {
        return noStoreJson({ error: 'Invalid cursor' }, 400);
      }
    }

    const rows = await prisma.organizationMember.findMany({
      where: { userId: user.userId, organization: { deletedAt: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        role: true,
        organization: { select: { id: true, name: true, createdAt: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last !== undefined ? last.id : null;

    return noStoreJson({
      items: page.map((row) => ({
        id: row.organization.id,
        name: row.organization.name,
        role: row.role,
        createdAt: row.organization.createdAt,
      })),
      nextCursor,
    });
  } catch (error) {
    console.error('[orgs] list organizations failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return noStoreJson({ error: 'Internal server error' }, 500);
  }
}
