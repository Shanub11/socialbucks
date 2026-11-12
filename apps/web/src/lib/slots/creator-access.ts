import { prisma } from '@repo/database';
/** The caller's live creator profile id, or null if they have none. userId is the INTERNAL user id from provisionedUserOrResponse, not the Clerk id. */
export async function getCreatorIdForUser(userId: string): Promise<string | null> {
  const creator = await prisma.creator.findFirst({ where: { userId, deletedAt: null }, select: { id: true } });
  return creator === null ? null : creator.id;
}