// apps/web/src/lib/social/token-clearing.test.ts
//
// Real-database integration tests for stored-token clearing on every
// revocation path in lib/social/creator-link.ts.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. DATABASE_URL/DIRECT_URL must point at the SAME test DB,
// because linkSocialAccount() writes through the @repo/database singleton
// prisma, which is wired to DATABASE_URL at module-load time.
// If RUN_DB_TESTS=1 but the DB is unreachable, the suite FAILS LOUDLY - it
// never silently skips.
//
// The social layer and the database client are imported dynamically inside
// beforeAll, after the guards below. A skipped run therefore never touches the
// shared prisma singleton and cannot fail on a missing DATABASE_URL.
//
// tokenCiphertext is only a string column at this layer, so dummy strings are
// used; no real encryption happens here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import type {
  PrismaClient,
  SocialPlatform as SocialPlatformEnum,
} from '@repo/database';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (RUN_DB_TESTS && !TEST_DATABASE_URL) {
  throw new Error(
    '[token-clearing.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.',
  );
}

if (RUN_DB_TESTS && TEST_DATABASE_URL) {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `[token-clearing.test] Refusing to run: database name "${dbName}" does not end in _test. ` +
        'Set TEST_DATABASE_URL to a _test database (e.g. socialbucks_test).',
    );
  }
}

// linkSocialAccount() writes through the shared @repo/database prisma
// singleton, which reads DATABASE_URL at import time. Guard explicitly so this
// test can never write to a different database.
if (
  RUN_DB_TESTS &&
  TEST_DATABASE_URL &&
  process.env.DATABASE_URL !== TEST_DATABASE_URL
) {
  throw new Error(
    '[token-clearing.test] DATABASE_URL must equal TEST_DATABASE_URL so that ' +
      'linkSocialAccount() writes to the test database. Set DATABASE_URL and ' +
      'DIRECT_URL to TEST_DATABASE_URL before running vitest.',
  );
}

let prisma: PrismaClient;
let SocialPlatform: typeof SocialPlatformEnum;
let social: typeof import('@/lib/social/creator-link');

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
let counter = 0;

interface Fixture {
  userId: string;
  creatorId: string;
  clerkId: string;
}

function nextSuffix(label: string): string {
  counter += 1;
  return `${label}_${RUN_SUFFIX}_${counter}`;
}

async function createUserWithCreator(label: string): Promise<Fixture> {
  const suffix = nextSuffix(label);
  const clerkId = `clerk_test_clear_${suffix}`;

  const user = await prisma.user.create({
    data: { clerkId, email: `clear_${suffix}@example.com` },
    select: { id: true },
  });

  const creator = await prisma.creator.create({
    data: { userId: user.id },
    select: { id: true },
  });

  return { userId: user.id, creatorId: creator.id, clerkId };
}

interface AccountOptions {
  platform: typeof SocialPlatformEnum[keyof typeof SocialPlatformEnum];
  externalId: string;
  ciphertext: string | null;
  expiresAt: Date | null;
  handle?: string;
  displayName?: string;
  /**
   * Optional soft-delete stamp. A revoked row occupies neither partial unique
   * slot ((creatorId, platform) or (platform, externalId)), so a fixture can
   * be created already revoked next to an active row on the same platform.
   */
  revokedAt?: Date | null;
}

const CONNECTED_AT = new Date('2026-01-02T03:04:05.000Z');
const EXPIRES_AT = new Date('2026-06-01T00:00:00.000Z');

async function createAccount(
  fixture: Fixture,
  options: AccountOptions,
): Promise<string> {
  const row = await prisma.socialAccount.create({
    data: {
      creatorId: fixture.creatorId,
      platform: options.platform,
      externalId: options.externalId,
      handle: options.handle ?? '@test_handle',
      displayName: options.displayName ?? 'Test Display',
      tokenCiphertext: options.ciphertext,
      tokenExpiresAt: options.expiresAt,
      scopes: ['test.scope'],
      connectedAt: CONNECTED_AT,
      revokedAt: options.revokedAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function cleanup(fixtures: Fixture[]): Promise<void> {
  for (const fixture of fixtures) {
    await prisma.socialAccount.deleteMany({
      where: { creatorId: fixture.creatorId },
    });
    await prisma.creator.deleteMany({ where: { id: fixture.creatorId } });
    await prisma.user.deleteMany({ where: { id: fixture.userId } });
  }
}

describeIf(RUN_DB_TESTS)('stored-token clearing - real DB', () => {
  beforeAll(async () => {
    const db = await import('@repo/database');
    prisma = new db.PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
    });
    SocialPlatform = db.SocialPlatform;
    social = await import('@/lib/social/creator-link');

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `[token-clearing.test] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('disconnectSocialPlatformForUser clears the token and leaves other rows alone', async () => {
    const fixtures: Fixture[] = [];
    try {
      const main = await createUserWithCreator('disc');
      const other = await createUserWithCreator('disc_other');
      fixtures.push(main, other);

      const ytExternal = `yt_${nextSuffix('disc')}`;
      const ytId = await createAccount(main, {
        platform: SocialPlatform.YOUTUBE,
        externalId: ytExternal,
        ciphertext: `v1.test.ciphertext.yt.${RUN_SUFFIX}`,
        expiresAt: EXPIRES_AT,
      });
      const igExternal = `ig_${nextSuffix('disc')}`;
      const igCiphertext = `v1.test.ciphertext.ig.${RUN_SUFFIX}`;
      const igId = await createAccount(main, {
        platform: SocialPlatform.INSTAGRAM,
        externalId: igExternal,
        ciphertext: igCiphertext,
        expiresAt: EXPIRES_AT,
      });
      const otherYtId = await createAccount(other, {
        platform: SocialPlatform.YOUTUBE,
        externalId: `yt_${nextSuffix('disc_other')}`,
        ciphertext: `v1.test.ciphertext.other.${RUN_SUFFIX}`,
        expiresAt: EXPIRES_AT,
      });

      const before = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: ytId },
      });

      await expect(
        social.disconnectSocialPlatformForUser(
          main.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toBe('disconnected');

      const after = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: ytId },
      });
      expect(after.revokedAt).not.toBeNull();
      expect(after.tokenCiphertext).toBeNull();
      expect(after.tokenExpiresAt).toBeNull();
      expect(after.handle).toBe(before.handle);
      expect(after.displayName).toBe(before.displayName);
      expect(after.scopes).toEqual(before.scopes);
      expect(after.externalId).toBe(before.externalId);
      expect(after.connectedAt).toEqual(before.connectedAt);

      await expect(
        social.disconnectSocialPlatformForUser(
          main.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toBe('not_connected');

      const instagram = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: igId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(instagram.revokedAt).toBeNull();
      expect(instagram.tokenCiphertext).toBe(igCiphertext);

      const otherYoutube = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: otherYtId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(otherYoutube.revokedAt).toBeNull();
      expect(otherYoutube.tokenCiphertext).not.toBeNull();
    } finally {
      await cleanup(fixtures);
    }
  });

  it('unlinkSocialAccount clears the token by platform and external id', async () => {
    const fixtures: Fixture[] = [];
    try {
      const main = await createUserWithCreator('unlink');
      fixtures.push(main);

      const externalId = `yt_${nextSuffix('unlink')}`;
      const accountId = await createAccount(main, {
        platform: SocialPlatform.YOUTUBE,
        externalId,
        ciphertext: `v1.test.ciphertext.unlink.${RUN_SUFFIX}`,
        expiresAt: EXPIRES_AT,
      });

      await expect(
        social.unlinkSocialAccount(SocialPlatform.YOUTUBE, externalId),
      ).resolves.toBe('unlinked');

      const row = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { revokedAt: true, tokenCiphertext: true, tokenExpiresAt: true },
      });
      expect(row.revokedAt).not.toBeNull();
      expect(row.tokenCiphertext).toBeNull();
      expect(row.tokenExpiresAt).toBeNull();

      await expect(
        social.unlinkSocialAccount(
          SocialPlatform.YOUTUBE,
          `unknown_${RUN_SUFFIX}`,
        ),
      ).resolves.toBe('not_found');
    } finally {
      await cleanup(fixtures);
    }
  });

  it('purgeSocialData clears the token and soft-deletes the creator', async () => {
    const fixtures: Fixture[] = [];
    try {
      const main = await createUserWithCreator('purge');
      fixtures.push(main);

      const externalId = `yt_${nextSuffix('purge')}`;
      const accountId = await createAccount(main, {
        platform: SocialPlatform.YOUTUBE,
        externalId,
        ciphertext: `v1.test.ciphertext.purge.${RUN_SUFFIX}`,
        expiresAt: EXPIRES_AT,
      });

      await expect(
        social.purgeSocialData(SocialPlatform.YOUTUBE, externalId),
      ).resolves.toBe('purged');

      const row = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { revokedAt: true, tokenCiphertext: true, tokenExpiresAt: true },
      });
      expect(row.revokedAt).not.toBeNull();
      expect(row.tokenCiphertext).toBeNull();
      expect(row.tokenExpiresAt).toBeNull();

      const creator = await prisma.creator.findUniqueOrThrow({
        where: { id: main.creatorId },
        select: { deletedAt: true },
      });
      expect(creator.deletedAt).not.toBeNull();
    } finally {
      await cleanup(fixtures);
    }
  });

  it('linkSocialAccount revoke-others branch clears the old token and keeps the new one', async () => {
    const fixtures: Fixture[] = [];
    try {
      const main = await createUserWithCreator('link');
      fixtures.push(main);

      const externalA = `yt_a_${nextSuffix('link')}`;
      const accountAId = await createAccount(main, {
        platform: SocialPlatform.YOUTUBE,
        externalId: externalA,
        ciphertext: `v1.test.ciphertext.a.${RUN_SUFFIX}`,
        expiresAt: EXPIRES_AT,
      });

      const externalB = `yt_b_${nextSuffix('link')}`;
      const newCiphertext = `v1.test.ciphertext.b.${RUN_SUFFIX}`;
      const result = await social.linkSocialAccount({
        clerkUserId: main.clerkId,
        platform: SocialPlatform.YOUTUBE,
        externalId: externalB,
        handle: '@b_handle',
        displayName: 'B Display',
        tokenCiphertext: newCiphertext,
        tokenExpiresAt: EXPIRES_AT,
        scopes: ['test.scope'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');

      const rowA = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: accountAId },
        select: { revokedAt: true, tokenCiphertext: true, tokenExpiresAt: true },
      });
      expect(rowA.revokedAt).not.toBeNull();
      expect(rowA.tokenCiphertext).toBeNull();
      expect(rowA.tokenExpiresAt).toBeNull();

      const rowB = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: result.accountId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(rowB.revokedAt).toBeNull();
      expect(rowB.tokenCiphertext).toBe(newCiphertext);
    } finally {
      await cleanup(fixtures);
    }
  });

  it('findActiveTokenCiphertexts returns only active, non-null rows for the user and platform', async () => {
    const fixtures: Fixture[] = [];
    try {
      const main = await createUserWithCreator('find');
      const nullUser = await createUserWithCreator('find_null');
      const other = await createUserWithCreator('find_other');
      fixtures.push(main, nullUser, other);

      // Partial unique indexes constrain ACTIVE rows only: a creator holds at
      // most one active row per platform, and a platform/externalId pair is
      // active at most once. Every fixture below respects both.

      // User A: one active YouTube row that carries a ciphertext, one revoked
      // YouTube row, and one active Instagram row. The revoked row gives no
      // conflict on the active (creatorId, platform) slot, and Instagram is a
      // different platform.
      const activeCiphertext = `v1.test.ciphertext.active.${RUN_SUFFIX}`;
      const activeId = await createAccount(main, {
        platform: SocialPlatform.YOUTUBE,
        externalId: `yt_active_${nextSuffix('find')}`,
        ciphertext: activeCiphertext,
        expiresAt: EXPIRES_AT,
      });

      // Created already revoked with a different externalId, and deliberately
      // still holding a ciphertext, so the assertions prove that revoked rows
      // are ignored even when they retain a value.
      const revokedCiphertext = `v1.test.ciphertext.revoked.${RUN_SUFFIX}`;
      const revokedAt = new Date('2025-12-01T00:00:00.000Z');
      const revokedId = await createAccount(main, {
        platform: SocialPlatform.YOUTUBE,
        externalId: `yt_revoked_${nextSuffix('find')}`,
        ciphertext: revokedCiphertext,
        expiresAt: EXPIRES_AT,
        revokedAt,
      });

      const instagramCiphertext = `v1.test.ciphertext.ig.${RUN_SUFFIX}`;
      const instagramId = await createAccount(main, {
        platform: SocialPlatform.INSTAGRAM,
        externalId: `ig_active_${nextSuffix('find')}`,
        ciphertext: instagramCiphertext,
        expiresAt: EXPIRES_AT,
      });

      // User B: a single active YouTube row with no stored ciphertext.
      const nullCiphertextId = await createAccount(nullUser, {
        platform: SocialPlatform.YOUTUBE,
        externalId: `yt_null_${nextSuffix('find_null')}`,
        ciphertext: null,
        expiresAt: null,
      });

      // User C: an unrelated creator with its own active YouTube credential.
      const otherCiphertext = `v1.test.ciphertext.other.${RUN_SUFFIX}`;
      const otherId = await createAccount(other, {
        platform: SocialPlatform.YOUTUBE,
        externalId: `yt_other_${nextSuffix('find_other')}`,
        ciphertext: otherCiphertext,
        expiresAt: EXPIRES_AT,
      });

      // The revoked row still holds its ciphertext, so the expectations below
      // prove that revocation, not an empty column, is what excludes it.
      const revokedRow = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: revokedId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(revokedRow.revokedAt).toEqual(revokedAt);
      expect(revokedRow.tokenCiphertext).toBe(revokedCiphertext);

      await expect(
        social.findActiveTokenCiphertexts(
          main.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toEqual([activeCiphertext]);

      await expect(
        social.findActiveTokenCiphertexts(
          main.clerkId,
          SocialPlatform.INSTAGRAM,
        ),
      ).resolves.toEqual([instagramCiphertext]);

      await expect(
        social.findActiveTokenCiphertexts(
          nullUser.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toEqual([]);

      // Cross-user isolation: A's row is invisible to B and C, C's row is
      // invisible to A. B's empty result excludes C by exact equality.
      await expect(
        social.findActiveTokenCiphertexts(
          other.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toEqual([otherCiphertext]);

      const mainResult = await social.findActiveTokenCiphertexts(
        main.clerkId,
        SocialPlatform.YOUTUBE,
      );
      expect(mainResult).not.toContain(otherCiphertext);
      expect(mainResult).not.toContain(revokedCiphertext);

      // Disconnecting A's YouTube clears A's credential and nothing else.
      await expect(
        social.disconnectSocialPlatformForUser(
          main.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toBe('disconnected');

      await expect(
        social.findActiveTokenCiphertexts(
          main.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toEqual([]);

      await expect(
        social.findActiveTokenCiphertexts(
          other.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toEqual([otherCiphertext]);

      // Straight from the database: only A's active YouTube row was revoked;
      // the Instagram, null-token and C rows are untouched.
      const disconnectedRow = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: activeId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(disconnectedRow.revokedAt).not.toBeNull();
      expect(disconnectedRow.tokenCiphertext).toBeNull();

      const instagramRow = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: instagramId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(instagramRow.revokedAt).toBeNull();
      expect(instagramRow.tokenCiphertext).toBe(instagramCiphertext);

      const nullRow = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: nullCiphertextId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(nullRow.revokedAt).toBeNull();
      expect(nullRow.tokenCiphertext).toBeNull();

      const otherRow = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: otherId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(otherRow.revokedAt).toBeNull();
      expect(otherRow.tokenCiphertext).toBe(otherCiphertext);
    } finally {
      await cleanup(fixtures);
    }
  });

  it('relink after disconnect reactivates the same row and stores the new ciphertext', async () => {
    const fixtures: Fixture[] = [];
    try {
      const main = await createUserWithCreator('relink');
      fixtures.push(main);

      const externalId = `yt_${nextSuffix('relink')}`;
      const accountId = await createAccount(main, {
        platform: SocialPlatform.YOUTUBE,
        externalId,
        ciphertext: `v1.test.ciphertext.old.${RUN_SUFFIX}`,
        expiresAt: EXPIRES_AT,
      });

      await expect(
        social.disconnectSocialPlatformForUser(
          main.clerkId,
          SocialPlatform.YOUTUBE,
        ),
      ).resolves.toBe('disconnected');

      const newCiphertext = `v1.test.ciphertext.new.${RUN_SUFFIX}`;
      const result = await social.linkSocialAccount({
        clerkUserId: main.clerkId,
        platform: SocialPlatform.YOUTUBE,
        externalId,
        handle: '@relinked',
        displayName: 'Relinked',
        tokenCiphertext: newCiphertext,
        tokenExpiresAt: EXPIRES_AT,
        scopes: ['test.scope'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');

      expect(result.accountId).toBe(accountId);

      const row = await prisma.socialAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { revokedAt: true, tokenCiphertext: true },
      });
      expect(row.revokedAt).toBeNull();
      expect(row.tokenCiphertext).toBe(newCiphertext);
    } finally {
      await cleanup(fixtures);
    }
  });
});
