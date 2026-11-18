// apps/worker/src/jobs/pg-boss-settlement-queue.test.ts
//
// What the settle queue's queue options actually do, proven against pg-boss
// 12.38.0 and a real database (ADR-0006 D3).
//
// The unit tests pin the options we pass; this one pins their meaning:
//
//   - the queue's `short` policy allows at most one QUEUED job per singleton key,
//     independent of any time bucket (case b), and allows a new one once the
//     first is no longer queued (case c);
//   - `singletonSeconds` puts a send in an epoch-aligned bucket, so the same key
//     twice inside 900 s inserts once and the second send resolves null (case a);
//   - different keys never block each other (case d).
//
// Nothing here consumes the queue: no worker is started, so a job stays queued
// until the test fetches it. Every queue is deleted by name in afterEach, and the
// throwaway schema pg-boss owns is dropped in afterAll, so a failing test cannot
// leave a queue or its jobs behind.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`.

import { randomBytes } from 'node:crypto';

import { prisma } from '@repo/database';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

if (!RUN_DB_TESTS) {
  console.warn(
    '[jobs/pg-boss-settlement-queue.test] RUN_DB_TESTS != 1 - the queue policy proof is SKIPPED, not passing.',
  );
}

if (RUN_DB_TESTS && !process.env.TEST_DATABASE_URL) {
  throw new Error(
    '[jobs/pg-boss-settlement-queue.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.',
  );
}

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

/** Only names this file generates may reach the DROP SCHEMA statement. */
const SCHEMA_PATTERN = /^pgboss_sq_t_[a-f0-9]{8}$/;

const QUEUE_PREFIX = 'settlement_probe_';

function newSchemaName(): string {
  return `pgboss_sq_t_${randomBytes(4).toString('hex')}`;
}

describeDb('settle queue options (real pg-boss)', () => {
  let boss: PgBoss;
  let schema: string;
  const createdQueues: string[] = [];

  /** A fresh queue per test, so a count is about this test's jobs only. */
  async function newQueue(): Promise<string> {
    const name = `${QUEUE_PREFIX}${randomBytes(4).toString('hex')}`;
    await boss.createQueue(name, { policy: 'short' });
    createdQueues.push(name);
    return name;
  }

  async function queuedCount(queue: string): Promise<number> {
    const stats = await boss.getQueueStats(queue);
    return stats[0]?.queuedCount ?? 0;
  }

  beforeAll(async () => {
    schema = newSchemaName();
    expect(schema).toMatch(SCHEMA_PATTERN);

    boss = new PgBoss({
      connectionString: process.env.TEST_DATABASE_URL,
      schema,
      max: 2,
      application_name: 'settlement-queue-proof',
    });

    await boss.start();
  });

  afterEach(async () => {
    // Deleting the queue removes its jobs with it (pg-boss owns the cascade).
    for (const name of createdQueues.splice(0)) {
      await boss.deleteQueue(name).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await boss.stop({ graceful: false }).catch(() => undefined);

    if (!SCHEMA_PATTERN.test(schema)) {
      throw new Error(`[settlement-queue-proof] refusing to drop an unexpected schema name: ${schema}`);
    }
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  });

  it("keeps the 'short' policy it was created with", async () => {
    const queue = await newQueue();

    const readBack = await boss.getQueue(queue);

    expect(readBack).not.toBeNull();
    expect(readBack!.policy).toBe('short');
  });

  it('suppresses a second send of the same key inside the 900 s bucket', async () => {
    const queue = await newQueue();
    const options = { singletonKey: 'slot_a', singletonSeconds: 900 };

    const first = await boss.send(queue, { slotId: 'a' }, options);
    const second = await boss.send(queue, { slotId: 'a' }, options);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await queuedCount(queue)).toBe(1);
  });

  it("suppresses a second queued send of the same key with no singletonSeconds: it is the policy, not the bucket", async () => {
    const queue = await newQueue();

    const first = await boss.send(queue, { slotId: 'b' }, { singletonKey: 'slot_b' });
    const second = await boss.send(queue, { slotId: 'b' }, { singletonKey: 'slot_b' });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await queuedCount(queue)).toBe(1);
  });

  it('allows a new job for the same key once the first is no longer queued', async () => {
    const queue = await newQueue();

    const first = await boss.send(queue, { slotId: 'c' }, { singletonKey: 'slot_c' });
    expect(first).not.toBeNull();

    // Take it out of the queued state the way a worker would.
    const fetched = await boss.fetch(queue, { batchSize: 1 });
    expect(fetched).toHaveLength(1);
    await boss.complete(queue, fetched[0]!.id);

    const second = await boss.send(queue, { slotId: 'c' }, { singletonKey: 'slot_c' });

    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(await queuedCount(queue)).toBe(1);
  });

  it('never blocks two different keys', async () => {
    const queue = await newQueue();

    const first = await boss.send(queue, { slotId: 'd1' }, { singletonKey: 'slot_d1' });
    const second = await boss.send(queue, { slotId: 'd2' }, { singletonKey: 'slot_d2' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await queuedCount(queue)).toBe(2);
  });
});
