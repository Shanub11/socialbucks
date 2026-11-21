// apps/web/src/lib/db/rls-lockdown.test.ts
//
// Real-database regression tests that verify the RLS-lockdown migration
// (20261121000000_enable_rls_and_revoke_data_api_grants) has been applied.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the DB is unreachable, the suite
// FAILS LOUDLY -- it never silently skips.
//
// These tests query only system catalogs; no data is written and
// resetTestDatabase is not needed.
//
// Run: RUN_DB_TESTS=1 TEST_DATABASE_URL=postgres://... vitest run rls-lockdown.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/database';
import { PrismaPg } from '@prisma/adapter-pg';

if (process.env.RUN_DB_TESTS !== '1') {
  console.warn(
    'RUN_DB_TESTS != 1 -- rls-lockdown tests are SKIPPED, not passing.',
  );
}
const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

describeDb('RLS lockdown (real DB)', () => {
  if (process.env.RUN_DB_TESTS === '1' && !process.env.TEST_DATABASE_URL) {
    throw new Error('RUN_DB_TESTS=1 but TEST_DATABASE_URL is not set.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
  });

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      throw new Error(
        `[rls-lockdown] RUN_DB_TESTS=1 but database is unreachable: ${String(err)}`,
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. Every ordinary table in schema public has RLS enabled
  // =========================================================================

  it('every public table has row-level security enabled', async () => {
    const tables: { relname: string }[] = await prisma.$queryRaw`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND c.relrowsecurity = false
    `;

    const names = tables.map((t) => t.relname);

    expect(
      names,
      `Tables without RLS: ${names.join(', ')}. A new table's migration must include ALTER TABLE ... ENABLE ROW LEVEL SECURITY.`,
    ).toEqual([]);
  });

  // =========================================================================
  // 2. The anon and authenticated roles have no table privileges in public
  // =========================================================================
  //
  // On plain PostgreSQL (CI, local dev) neither anon nor authenticated exist.
  // The test passes with nothing to check: when a role does not exist, the
  // inner loop body never executes, so no assertion can fail.  This is
  // correct -- the absence of the role means the Data API surface is not
  // present and there is nothing to lock down.

  it('anon and authenticated have no table privileges in schema public', async () => {
    const dataApiRoles = ['anon', 'authenticated'] as const;

    for (const role of dataApiRoles) {
      const roleExists: { exists: boolean }[] = await prisma.$queryRaw`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS "exists"
      `;

      if (!roleExists[0]?.exists) {
        // Role does not exist in this database (plain Postgres / CI).
        // Nothing to check -- see comment above.
        continue;
      }

      const violations: { relname: string }[] = await prisma.$queryRaw`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND has_table_privilege(${role}, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         ORDER BY c.relname
      `;

      expect(
        violations.map((v) => v.relname),
        `${role} still has table privileges on: ${violations.map((v) => v.relname).join(', ')}`,
      ).toEqual([]);
    }
  });
});
