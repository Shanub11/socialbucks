// apps/worker/src/test-support/reset-test-db.ts
//
// Empties the slot tables before a real-database suite runs.
//
// Why this exists when every fixture already deletes its own rows: the settlement
// sweeps select the whole table, so a row left behind by a killed run - or by the
// web suite, which shares the same test database - changes `scanned`, `enqueued`
// and `truncated` for a test that only meant to create three slots. Per-test
// cleanup cannot fix that, because the stray row was never this test's.
//
// The safety rules are stricter than "it is only a test helper":
//   - it refuses unless DATABASE_URL is byte-identical to TEST_DATABASE_URL, so a
//     shell variable cannot point it at a development or production database;
//   - it refuses unless that URL's database name ends in `_test`;
//   - it refuses before running any SQL, not after the first statement;
//   - the message names no URL, host or credential - the reason is the decision,
//     and the value is not the operator's business in a log.
//
// The table list, order and statement mirror apps/web/src/test/reset-test-db.ts
// exactly, so the two suites cannot disagree about what "empty" means.

import type { PrismaClient } from '@repo/database';

/**
 * Every application table, in FK-safe order, exactly as the web helper truncates
 * them. `RESTART IDENTITY` keeps generated ids predictable across suites;
 * `CASCADE` covers any table added later without a migration to this list.
 */
export const TRUNCATED_TABLES = [
  'PayoutEvent',
  'CampaignCreatorSlot',
  'SocialAccount',
  'Campaign',
  'OrganizationMember',
  'Organization',
  'Creator',
  'User',
] as const;

/**
 * The one statement this helper runs.
 *
 * A constant with no interpolation: table names cannot be bound parameters, so
 * the safety comes from the string being fixed at compile time and the caller
 * never supplying any part of it. This is the single place in the worker that
 * uses an unsafe raw call, and it exists only in test support - the job code
 * uses the tagged `$queryRaw` form (ADR-0006 constraint 7).
 */
export const RESET_SQL = `TRUNCATE TABLE ${TRUNCATED_TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`;

/** The slice of the client this helper needs, so a test can fake it. */
export interface ResetClient {
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown[]>;
}

export interface ResetEnvironment {
  DATABASE_URL?: string | undefined;
  TEST_DATABASE_URL?: string | undefined;
}

/** The database name in a postgres URL, or null if the URL cannot be parsed. */
function databaseNameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, '');
    return name === '' ? null : decodeURIComponent(name);
  } catch {
    return null;
  }
}

/**
 * Throws unless the process is unambiguously pointed at a `*_test` database that
 * the test runner also configured. Runs before every statement.
 *
 * @throws {Error} with a message that names no URL, host or credential.
 */
export function assertResettableTarget(env: ResetEnvironment): void {
  const databaseUrl = env.DATABASE_URL;
  const testDatabaseUrl = env.TEST_DATABASE_URL;

  if (databaseUrl === undefined || databaseUrl === '' || testDatabaseUrl === undefined || testDatabaseUrl === '') {
    throw new Error(
      '[reset-test-db] refusing to truncate: DATABASE_URL and TEST_DATABASE_URL must both be set',
    );
  }

  if (databaseUrl !== testDatabaseUrl) {
    throw new Error(
      '[reset-test-db] refusing to truncate: DATABASE_URL must equal TEST_DATABASE_URL',
    );
  }

  const name = databaseNameOf(databaseUrl);
  if (name === null || !name.endsWith('_test')) {
    throw new Error(
      '[reset-test-db] refusing to truncate: the test database name must end in _test',
    );
  }
}

/**
 * Empties every application table so a sweep's counts describe only this suite's
 * fixtures.
 *
 * Call once in `beforeAll`; per-test cleanup stays by id, as fixtures.ts does.
 *
 * @throws {Error} before any SQL when the target is not a `*_test` database, or
 *   when the connected database disagrees with the configured name.
 */
export async function resetSlotTables(
  db: ResetClient | PrismaClient,
  env: ResetEnvironment = process.env,
): Promise<void> {
  // Order matters: this must be the first thing that can fail.
  assertResettableTarget(env);

  // Second guard, on the connection rather than the configuration: a URL can name
  // one database and the pooler can route to another.
  const rows = (await db.$queryRawUnsafe('SELECT current_database()')) as unknown[];
  const current = (rows[0] as { current_database?: unknown } | undefined)?.current_database;

  if (typeof current !== 'string' || !current.endsWith('_test')) {
    throw new Error(
      '[reset-test-db] refusing to truncate: the connected database name must end in _test',
    );
  }

  await db.$queryRawUnsafe(RESET_SQL);
}
