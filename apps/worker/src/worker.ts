// apps/worker/src/worker.ts
//
// The pg-boss host: one connection, one queue, one stop path (ADR-0003 D5).
//
// Stage 1 deliberately contains no settlement work. The only queue is the ping
// queue, and it exists to prove the round trip (enqueue -> consume) against the
// configured schema; it is not a business job and never touches money.

import { PgBoss } from 'pg-boss';
import type { Job } from 'pg-boss';

import type { WorkerConfig } from './config';
import type { Logger } from './logger';

/**
 * Liveness and smoke-test queue only. It carries no settlement work: settlement,
 * invite expiry and the sweepers arrive in the next task (ADR-0003 D5).
 */
export const PING_QUEUE = 'system.ping';

/** How the worker identifies itself in pg_stat_activity and pg-boss's instance list. */
export const APPLICATION_NAME = 'socialbucks-worker';

export interface WorkerHandle {
  boss: PgBoss;
  /** Idempotent, graceful: every call returns the same promise. */
  stop: () => Promise<void>;
}

/** Builds the pg-boss instance. Injectable so tests do not need a database. */
export type PgBossFactory = (config: WorkerConfig) => PgBoss;

export function createPgBoss(config: WorkerConfig): PgBoss {
  return new PgBoss({
    connectionString: config.databaseUrl,
    schema: config.pgbossSchema,
    max: config.pgbossPoolMax,
    application_name: APPLICATION_NAME,
  });
}

/**
 * Starts pg-boss, ensures the ping queue exists and registers its handler.
 *
 * pg-boss owns and migrates its own schema during start() (ADR-0005 D3); the
 * worker never touches the application schema, which is ADR-0003 D5's
 * "the worker never runs migrations".
 *
 * @param createBoss - factory override for tests; defaults to the real PgBoss.
 */
export async function startWorker(
  config: WorkerConfig,
  logger: Logger,
  createBoss: PgBossFactory = createPgBoss,
): Promise<WorkerHandle> {
  const boss = createBoss(config);

  // Registered before start(): pg-boss emits 'error' for background failures
  // (maintenance, supervision) and an unhandled 'error' event would end the
  // process without an explanation.
  boss.on('error', (error: unknown) => {
    logger.error('pg-boss error', { error });
  });

  try {
    await boss.start();

    // createQueue is idempotent (INSERT ... ON CONFLICT DO NOTHING), so this is
    // safe on every boot and does not depend on a previous deployment.
    await boss.createQueue(PING_QUEUE);

    await boss.work(PING_QUEUE, async (jobs: Job[]) => {
      // Debug level on purpose: a ping is expected, not news.
      logger.debug('ping', { jobs: jobs.length });
    });
  } catch (error) {
    // A half-started instance would keep its pool open and hold the process up.
    await boss.stop({ graceful: false }).catch(() => {
      // The startup error is the one worth reporting.
    });
    throw error;
  }

  let stopPromise: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    stopPromise ??= boss.stop({ graceful: true, close: true, timeout: config.shutdownTimeoutMs });
    return stopPromise;
  };

  return { boss, stop };
}
