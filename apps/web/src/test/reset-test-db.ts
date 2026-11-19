// apps/web/src/test/reset-test-db.ts
//
// Resets all tables in the test database to empty rows and restarts identity
// for every affected table. Used as a cleanup fallback when individual test
// runs cannot clean up their own fixture rows (e.g. a crashed test left rows
// behind, or tests ran sequentially in an environment where afterAll never
// fired).
//
// Tables are truncated in FK-safe order, mirroring apps/web/src/lib/settlement/settle-slot.test.ts
// cleanSlotFixture() so a FK violation never blocks the reset. Errors are logged
// but not swallowed — a reset failure is visible instead of masking a later test
// that queries the same table.
//
// Copyright (c) 2026 socialbucks. All rights reserved.

/**
 * Reset every application table to empty rows with identity restarted.
 * Run via RUN_DB_TESTS=1 scripts or as a global setup hook. If no DATABASE_URL
 * is set at all, does nothing (RUN_DB_TESTS gates execution).
 *
 * This function MUST only run against a database whose name ends in `_test`
 * — the guard is enforced here and in individual test files to prevent
 * accidental truncation of production or development data.
 */
export async function resetTestDatabase(db: {
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown[]>;
  $executeRawUnsafe?: (sql: string, ...params: unknown[]) => Promise<unknown>;
}): Promise<void> {
  // Guard: refuse to truncate if not a *_test database (mirrors settle-slot.test.ts guard)
  try {
    const result = await db.$queryRawUnsafe(
      `SELECT current_database()`,
    ) as { current_database: string }[];
    const dbName = result[0]?.current_database;
    if (!dbName?.endsWith('_test')) {
      throw new Error(
        `[reset-test-db] Refusing to truncate: database "${dbName}" does not end in _test. ` +
        'Set TEST_DATABASE_URL to a _test database (e.g. socialbucks_test).',
      );
    }
  } catch (err) {
    // If the guard query fails (e.g. not a Postgres connection), fail closed
    throw new Error(
      `[reset-test-db] Could not verify _test database guard: ${String(err)}`,
    );
  }

  // FK-safe truncate order. Truncate is faster than DELETE when we can afford
  // to lose identity; RESTART IDENTITY keeps the sequence stable enough for
  // subsequent fresh-seed fixtures in this file.
  const sqls = [
    `TRUNCATE TABLE "PayoutEvent", "CampaignCreatorSlot", "SocialAccount", "Campaign", "OrganizationMember", "Organization", "Creator", "User" RESTART IDENTITY CASCADE`,
  ];

  for (const sql of sqls) {
    try {
      await db.$queryRawUnsafe(sql);
    } catch (err) {
      console.error('[reset-test-db] failed:', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}