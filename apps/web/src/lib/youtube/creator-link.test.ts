// apps/web/src/lib/youtube/creator-link.test.ts
//
// Real-database integration tests for linkYouTubeAccount().
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. DATABASE_URL/DIRECT_URL must point at the SAME test DB,
// because linkYouTubeAccount() -> linkSocialAccount() writes through the
// @repo/database singleton prisma, which is wired to DATABASE_URL at
// module-load time (see packages/database/src/index.ts).
// If RUN_DB_TESTS=1 but the DB is unreachable, the suite FAILS LOUDLY — it
// never silently skips.
//
// No Clerk mocking is needed: linkSocialAccount() resolves the user by
// clerkId directly, so we seed one User row and pass its clerkId.
// Encryption is real: vitest.config.ts provides a valid dummy
// YOUTUBE_TOKEN_ENCRYPTION_KEY, so the phase-2 re-link encrypts a real token.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';
import { linkYouTubeAccount } from './creator-link';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (RUN_DB_TESTS && !TEST_DATABASE_URL) {
  throw new Error(
    '[creator-link.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.',
  );
}

if (RUN_DB_TESTS && TEST_DATABASE_URL) {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `[creator-link.test] Refusing to run: database name "${dbName}" does not end in _test. ` +
        'Set TEST_DATABASE_URL to a _test database (e.g. socialbucks_test).',
    );
  }
}

// linkYouTubeAccount() -> linkSocialAccount() writes through the shared
// @repo/database prisma singleton, which reads DATABASE_URL at import time.
// Guard explicitly so this test can never write to a different database.
if (
  RUN_DB_TESTS &&
  TEST_DATABASE_URL &&
  process.env.DATABASE_URL !== TEST_DATABASE_URL
) {
  throw new Error(
    '[creator-link.test] DATABASE_URL must equal TEST_DATABASE_URL so that ' +
      'linkYouTubeAccount() writes to the test database. Set DATABASE_URL and ' +
      'DIRECT_URL to TEST_DATABASE_URL before running vitest.',
  );
}

let prisma: PrismaClient;

if (RUN_DB_TESTS && TEST_DATABASE_URL) {
  const adapter = new PrismaPg({ connectionString: TEST_DATABASE_URL });
  prisma = new PrismaClient({ adapter });
}

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

describeIf(RUN_DB_TESTS)('linkYouTubeAccount — real DB', () => {
  beforeAll(async () => {
    if (!prisma) return;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `[creator-link.test] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('NULL refresh token persists tokenCiphertext as NULL and does not throw; re-link with a token overwrites it', async () => {
    // creatorId is captured from phase 1 only so the finally-block cleanup
    // can run even if phase 2 throws — we never touch the DB for ids we
    // didn't capture.
    let creatorId: string | undefined;

    const suffix = Math.random().toString(36).slice(2, 8);
    const clerkId = `clerk_test_link_${suffix}`;
    const externalId = `uc_test_${suffix}`;

    const user = await prisma.user.create({
      data: { clerkId, email: `link_${suffix}@example.com` },
      select: { id: true },
    });

    try {
      // Phase 1: Google returns no refresh token -> tokenCiphertext must be
      // stored as NULL with no error.
      const result1 = await linkYouTubeAccount({
        clerkUserId: clerkId,
        channel: {
          id: externalId,
          title: `Channel ${suffix}`,
          customUrl: `@handle_${suffix}`,
          duration: null,
          subscriberCount: null,
          videoCount: null,
        },
        tokens: {
          accessToken: 'ya29.fake-access-token',
          refreshToken: null,
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600 * 1000),
          grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
        },
      });
      expect(result1.ok).toBe(true);
      if (!result1.ok) throw new Error('unreachable');

      creatorId = result1.creatorId;

      const row1 = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: result1.accountId },
        select: {
          tokenCiphertext: true,
          revokedAt: true,
          tokenExpiresAt: true,
        },
      });
      expect(row1.tokenCiphertext).toBeNull();
      expect(row1.revokedAt).toBeNull();
      expect(row1.tokenExpiresAt).toBeNull();

      // Phase 2: re-link with a refresh token -> same row reactivated,
      // tokenCiphertext overwritten with the encrypted token.
      const result2 = await linkYouTubeAccount({
        clerkUserId: clerkId,
        channel: {
          id: externalId,
          title: `Channel ${suffix}`,
          customUrl: `@handle_${suffix}`,
          duration: null,
          subscriberCount: null,
          videoCount: null,
        },
        tokens: {
          accessToken: 'ya29.fake-access-token-2',
          refreshToken: 'ya29.fake-refresh-token-' + suffix,
          expiresIn: 3600,
          expiresAt: new Date(Date.now() + 3600 * 1000),
          grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
        },
      });
      expect(result2.ok).toBe(true);
      if (!result2.ok) throw new Error('unreachable');

      // Same account row was updated in place, not duplicated.
      expect(result2.accountId).toBe(result1.accountId);
      expect(result2.creatorId).toBe(creatorId);

      const row2 = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: result1.accountId },
        select: { tokenCiphertext: true, revokedAt: true },
      });
      expect(row2.tokenCiphertext).not.toBeNull();
      expect(typeof row2.tokenCiphertext).toBe('string');
      expect(row2.revokedAt).toBeNull();
    } finally {
      // FK-safe cleanup order: SocialAccount -> Creator -> User.
      if (creatorId) {
        await prisma.socialAccount.deleteMany({ where: { creatorId } });
        await prisma.creator.deleteMany({ where: { id: creatorId } });
      }
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });
});
