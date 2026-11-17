// apps/worker/src/pg-boss.smoke.test.ts
//
// Real-database smoke test for the worker host: start pg-boss in a throwaway
// schema, enqueue one system.ping job, prove it is consumed, then stop twice.
//
// REQUIRES: RUN_DB_TESTS=1 and a reachable PostgreSQL at TEST_DATABASE_URL
// ending in `_test`. If RUN_DB_TESTS=1 but the database is unreachable, the
// suite FAILS LOUDLY - it never silently skips.
//
// The schema is created by pg-boss and dropped here; no application table is
// read or written, and no Prisma migration runs.

import { randomBytes } from 'node:crypto';

import { prisma } from '@repo/database';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config';
import type { Logger } from './logger';
import { PING_QUEUE, startWorker, type WorkerHandle } from './worker';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

if (!RUN_DB_TESTS) {
  console.warn(
    '[pg-boss.smoke.test] RUN_DB_TESTS != 1 - the pg-boss smoke test is SKIPPED, not passing.',
  );
}

if (RUN_DB_TESTS && !process.env.TEST_DATABASE_URL) {
  throw new Error('[pg-boss.smoke.test] RUN_DB_TESTS=1 requires TEST_DATABASE_URL to be set.');
}

const describeDb = RUN_DB_TESTS ? describe : describe.skip;

/** Only names this file generates may reach the DROP SCHEMA statement. */
const SCHEMA_PATTERN = /^pgboss_t_[a-f0-9]{8}$/;

const PING_TIMEOUT_MS = 20_000;

function newSchemaName(): string {
  return `pgboss_t_${randomBytes(4).toString('hex')}`;
}

/**
 * Records logger calls so the test can wait for the ping handler without
 * depending on stdout, and can fail on a pg-boss error event.
 */
function recordingLogger(): { logger: Logger; ping: Promise<void>; errors: string[] } {
  let resolvePing!: () => void;
  const ping = new Promise<void>((resolve) => {
    resolvePing = resolve;
  });

  const errors: string[] = [];

  const logger: Logger = {
    debug: (msg) => {
      if (msg === 'ping') resolvePing();
    },
    info: () => undefined,
    warn: () => undefined,
    error: (msg) => {
      errors.push(msg);
    },
    child: () => logger,
  };

  return { logger, ping, errors };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`[pg-boss.smoke] ${message} (waited ${ms}ms)`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function dropSchema(schema: string): Promise<void> {
  // A Postgres identifier cannot be a bound parameter, so this validation is the
  // guard that keeps the generated name the only thing that reaches the SQL.
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error(`[pg-boss.smoke] refusing to drop an unexpected schema name: ${schema}`);
  }
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

describeDb('pg-boss host (real DB)', () => {
  it(
    'consumes a system.ping job and stops idempotently',
    async () => {
      const schema = newSchemaName();
      expect(schema).toMatch(SCHEMA_PATTERN);

      const config = loadConfig({
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        PGBOSS_SCHEMA: schema,
        PGBOSS_POOL_MAX: '2',
        LOG_LEVEL: 'info',
      });

      const recorder = recordingLogger();
      let handle: WorkerHandle | undefined;

      try {
        handle = await startWorker(config, recorder.logger);

        const jobId = await handle.boss.send(PING_QUEUE, {});
        expect(jobId).not.toBeNull();

        await withTimeout(recorder.ping, PING_TIMEOUT_MS, 'the ping job was never consumed');

        await handle.stop();
        // A second stop resolves without error and does not stop anything twice.
        await expect(handle.stop()).resolves.toBeUndefined();

        expect(recorder.errors).toEqual([]);
      } finally {
        if (handle !== undefined) {
          await handle.stop().catch(() => undefined);
        }
        await dropSchema(schema);
        await prisma.$disconnect();
      }
    },
    60_000,
  );
});
