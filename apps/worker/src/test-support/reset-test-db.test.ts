// apps/worker/src/test-support/reset-test-db.test.ts
//
// The reset helper's guards, without a database.
//
// The property that matters is not "it truncates" but "it refuses before it has
// run anything": a guard that fires after the first statement has already
// truncated a table. Every refusal case here asserts a zero-length call list,
// and the fake client records every statement it is asked to run.

import { describe, expect, it } from 'vitest';

import {
  assertResettableTarget,
  resetSlotTables,
  RESET_SQL,
  TRUNCATED_TABLES,
} from './reset-test-db';

const TEST_URL = 'postgres://user:password@127.0.0.1:5432/socialbucks_test';
const OTHER_TEST_URL = 'postgres://user:password@127.0.0.1:5432/other_test';
const PRODUCTION_URL = 'postgres://user:password@127.0.0.1:5432/socialbucks';

/** A client that records the statements it was asked to run. */
function fakeClient(rows: unknown[] = [{ current_database: 'socialbucks_test' }]): {
  calls: string[];
  client: { $queryRawUnsafe: (sql: string) => Promise<unknown[]> };
} {
  const calls: string[] = [];

  return {
    calls,
    client: {
      $queryRawUnsafe: async (sql: string) => {
        calls.push(sql);
        return rows;
      },
    },
  };
}

describe('resetSlotTables guards', () => {
  it('refuses, before any SQL, when the database name does not end in _test', async () => {
    const fake = fakeClient();

    await expect(
      resetSlotTables(fake.client, {
        DATABASE_URL: PRODUCTION_URL,
        TEST_DATABASE_URL: PRODUCTION_URL,
      }),
    ).rejects.toThrow(/must end in _test/);

    expect(fake.calls).toEqual([]);
  });

  it('refuses, before any SQL, when DATABASE_URL differs from TEST_DATABASE_URL', async () => {
    const fake = fakeClient();

    await expect(
      resetSlotTables(fake.client, {
        DATABASE_URL: OTHER_TEST_URL,
        TEST_DATABASE_URL: TEST_URL,
      }),
    ).rejects.toThrow(/must equal TEST_DATABASE_URL/);

    expect(fake.calls).toEqual([]);
  });

  it('refuses, before any SQL, when either variable is unset', async () => {
    const fake = fakeClient();

    await expect(
      resetSlotTables(fake.client, { TEST_DATABASE_URL: TEST_URL }),
    ).rejects.toThrow(/must both be set/);

    expect(fake.calls).toEqual([]);
  });

  it('refuses when the connected database disagrees with the configured name', async () => {
    const fake = fakeClient([{ current_database: 'socialbucks' }]);

    await expect(
      resetSlotTables(fake.client, { DATABASE_URL: TEST_URL, TEST_DATABASE_URL: TEST_URL }),
    ).rejects.toThrow(/connected database name must end in _test/);

    // The connection check ran; the truncate did not.
    expect(fake.calls).toEqual(['SELECT current_database()']);
  });

  it('names no URL, host or credential in any refusal', async () => {
    const messages: string[] = [];

    for (const env of [
      { DATABASE_URL: PRODUCTION_URL, TEST_DATABASE_URL: PRODUCTION_URL },
      { DATABASE_URL: OTHER_TEST_URL, TEST_DATABASE_URL: TEST_URL },
      { DATABASE_URL: 'not-a-url', TEST_DATABASE_URL: 'not-a-url' },
    ]) {
      try {
        assertResettableTarget(env);
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).not.toContain('postgres://');
      expect(message).not.toContain('127.0.0.1');
      expect(message).not.toContain('password');
      expect(message).not.toContain('socialbucks');
    }
  });

  it('proceeds when both hold, truncating the same tables the web helper does', async () => {
    const fake = fakeClient();

    await expect(
      resetSlotTables(fake.client, { DATABASE_URL: TEST_URL, TEST_DATABASE_URL: TEST_URL }),
    ).resolves.toBeUndefined();

    expect(fake.calls).toEqual(['SELECT current_database()', RESET_SQL]);
    expect(RESET_SQL).toBe(
      'TRUNCATE TABLE "PayoutEvent", "CampaignCreatorSlot", "SocialAccount", "Campaign", ' +
        '"OrganizationMember", "Organization", "Creator", "User" RESTART IDENTITY CASCADE',
    );
    expect([...TRUNCATED_TABLES]).toEqual([
      'PayoutEvent',
      'CampaignCreatorSlot',
      'SocialAccount',
      'Campaign',
      'OrganizationMember',
      'Organization',
      'Creator',
      'User',
    ]);
  });
});
