// apps/worker/src/shutdown.test.ts
//
// Unit tests for the idempotent stop path, using a fake PgBoss injected through
// the factory parameter. No database is contacted.

import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config';
import type { Logger } from './logger';
import { PING_QUEUE, startWorker } from './worker';

const SHUTDOWN_TIMEOUT_MS = 12_345;

function testConfig() {
  return loadConfig({
    DATABASE_URL: 'postgres://worker:secret@localhost:5432/socialbucks_test',
    SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
  });
}

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

function fakeBoss() {
  const on = vi.fn();
  const start = vi.fn(async () => undefined);
  const createQueue = vi.fn(async () => undefined);
  const work = vi.fn(async () => 'worker-id');
  const stop = vi.fn(async () => undefined);

  const boss = { on, start, createQueue, work, stop } as unknown as PgBoss;

  return { boss, on, start, createQueue, work, stop };
}

describe('startWorker stop()', () => {
  it('stops once and returns the same promise for concurrent callers', async () => {
    const fake = fakeBoss();
    const handle = await startWorker(testConfig(), silentLogger(), () => fake.boss);

    const first = handle.stop();
    const second = handle.stop();
    const third = handle.stop();

    expect(second).toBe(first);
    expect(third).toBe(first);

    await Promise.all([first, second, third]);

    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('passes the configured timeout to the graceful stop', async () => {
    const fake = fakeBoss();
    const handle = await startWorker(testConfig(), silentLogger(), () => fake.boss);

    await handle.stop();

    expect(fake.stop).toHaveBeenCalledWith({
      graceful: true,
      close: true,
      timeout: SHUTDOWN_TIMEOUT_MS,
    });
  });

  it('keeps the same promise for a call after the stop resolved', async () => {
    const fake = fakeBoss();
    const handle = await startWorker(testConfig(), silentLogger(), () => fake.boss);

    const first = handle.stop();
    await first;
    const later = handle.stop();

    expect(later).toBe(first);
    await expect(later).resolves.toBeUndefined();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('starts pg-boss in the configured schema and registers the ping queue', async () => {
    const fake = fakeBoss();
    const config = testConfig();

    await startWorker(config, silentLogger(), () => fake.boss);

    expect(fake.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.createQueue).toHaveBeenCalledWith(PING_QUEUE);
    expect(fake.work).toHaveBeenCalledWith(PING_QUEUE, expect.any(Function));
  });

  it('stops pg-boss when start fails, so the pool cannot outlive the failure', async () => {
    const fake = fakeBoss();
    fake.start.mockRejectedValueOnce(new Error('database is down'));

    await expect(startWorker(testConfig(), silentLogger(), () => fake.boss)).rejects.toThrow(
      'database is down',
    );

    expect(fake.stop).toHaveBeenCalledWith({ graceful: false });
  });
});
