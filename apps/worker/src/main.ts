// apps/worker/src/main.ts
//
// Entry point for the settlement worker host (ADR-0003 D5, ADR-0005, ADR-0006).
//
// Startup order is a decision, not an accident (ADR-0006 D6, R10):
//
//   1. configuration  - exit 2 on a bad environment, before anything reads it;
//   2. logger         - so every later failure can be reported structurally;
//   3. settlement env - jobs/deps.js is dynamically imported and its preflight
//                       (loadSettlementEnv) runs HERE, before any database
//                       client exists: exit 2, variable names only (D8);
//   4. database       - dynamically imported, own client built, then proven with
//                       `SELECT 1`;
//   5. dependencies   - buildDeps() binds the web app's settlement code; a
//                       missing binding is a startup failure (exit 1);
//   6. pg-boss        - start the host, then register the queues and handlers.
//
// The settlement preflight sits before the database on purpose. If it ran later,
// a missing YouTube variable would be reported as (or after) a database failure,
// and the operator would go looking at the connection string for a problem that
// is a missing key. Both checks exit 2 only for configuration, and both name
// variables rather than values.
//
// The database and the web modules read process.env as they are *imported*, so
// importing either one any earlier reports the wrong error. That is the reason
// the imports are dynamic - and it has a second benefit: the static graph of
// this file stays free of @repo/database, of everything under apps/web and of
// jobs/deps.ts, which is exactly what the startup-graph test asserts.
//
// There is no HTTP server and no listening port: the process consumes work, and
// its health is observed through the platform and the logs.

import type { PrismaClient } from '@repo/database';

import { ConfigError, loadConfig, type WorkerConfig } from './config';
import { describeError } from './errors';
import type { JobContext, JobDeps } from './jobs/context';
import { createLogger, type Logger } from './logger';
import { startWorker, type WorkerHandle } from './worker';

/** 2 is "configuration is wrong"; 1 is "everything else". */
const EXIT_CONFIG_ERROR = 2;
const EXIT_FATAL = 1;

/** Slack on top of the graceful-stop timeout before the process is forced down. */
const HARD_EXIT_BUFFER_MS = 5_000;

/**
 * One fixed message for both halves of database startup. The reason (a missing
 * variable, a wrong host, a refused connection) is in the error name and code;
 * the message is not repeated because it can quote the connection string.
 */
const DATABASE_INIT_FAILED = 'database client failed to initialise';

/**
 * Reads configuration without ever printing a stack or a value: a wrong
 * DATABASE_URL must not put the password in the platform log.
 */
function readConfig(): WorkerConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`worker: ${error.message}\n`);
      process.exit(EXIT_CONFIG_ERROR);
    }
    process.stderr.write('worker: configuration could not be loaded\n');
    process.exit(EXIT_FATAL);
  }
}

/**
 * The shape main.ts needs from jobs/deps.js. Declared here rather than derived
 * from the module so the static graph of this file names nothing under
 * jobs/deps (startup-graph.test.ts walks exactly that).
 */
interface DepsModule {
  loadSettlementEnv: (source: Record<string, string | undefined>) => unknown;
  buildDeps: () => JobDeps;
}

/**
 * Last resort for failures outside the job and shutdown paths. The platform
 * restarts the service, so the only job here is to exit non-zero with a line
 * that says what happened - and the line carries the error's name, never its
 * message (R6: a message can quote the environment).
 */
function installFatalHandlers(logger: Logger): void {
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { ...describeError(error) });
    process.exit(EXIT_FATAL);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { ...describeError(reason) });
    process.exit(EXIT_FATAL);
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel, { nodeEnv: config.nodeEnv });

  installFatalHandlers(logger);

  // Step 3: the settlement environment, before the database (ADR-0006 D6, D8).
  //
  // The module is imported first and the preflight is called immediately: the
  // import itself loads apps/web's settlement modules, which read their values
  // lazily, so nothing below this point has to parse the environment again.
  //
  // A ConfigError is the only "the operator must fix the environment" outcome,
  // so it is the only one that exits 2 - and it is printed the same way readConfig
  // prints its own, with a `worker: ` prefix and no stack.
  let depsModule: DepsModule;
  try {
    depsModule = (await import('./jobs/deps.js')) as DepsModule;
    depsModule.loadSettlementEnv(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`worker: ${error.message}\n`);
      process.exit(EXIT_CONFIG_ERROR);
    }
    logger.error('job dependencies failed to initialise', { ...describeError(error) });
    process.exit(EXIT_FATAL);
  }

  // Step 4a: create the client.
  //
  // The import happens here because the package builds its default singleton from
  // DATABASE_URL as it is imported - but the worker does not use that singleton.
  // It builds its own client with the 'worker' profile, which turns Prisma's own
  // logging off and sets a connect timeout (ADR-0006 D9): Prisma writes
  // `prisma:error` blocks straight to the process output, outside this logger and
  // its redaction, quoting the database user and host.
  let db: PrismaClient;
  try {
    const database = await import('@repo/database');
    db = database.createPrismaClient({
      connectionString: config.databaseUrl,
      profile: 'worker',
    });
  } catch (error) {
    logger.error(DATABASE_INIT_FAILED, { ...describeError(error) });
    process.exit(EXIT_FATAL);
  }

  // Step 4b: prove the connection. A failure here is not retried by this
  // process - a worker that cannot reach its database should not hold a pg-boss
  // pool open waiting for a fix it cannot make; the platform restarts it. The
  // connect timeout above bounds how long this can take.
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (error) {
    logger.error(DATABASE_INIT_FAILED, { ...describeError(error) });
    process.exit(EXIT_FATAL);
  }

  // Step 5: bind the web app's code (ADR-0006 D5, D7).
  //
  // A missing settleSlot is a startup failure, never a worker that accepts
  // settlement work and silently drops it: buildDeps() always binds it, and if
  // that ever stops being true the process must not start at all.
  let deps: JobDeps;
  try {
    deps = depsModule.buildDeps();
    if (deps.settleSlot === undefined) {
      throw new Error('job dependencies are incomplete: settleSlot is not bound');
    }
  } catch (error) {
    logger.error('job dependencies failed to initialise', { ...describeError(error) });
    process.exit(EXIT_FATAL);
  }

  const ctx: JobContext = { db, logger, now: () => new Date() };

  // Step 6: start the host and hand it the queues. register.ts value-imports the
  // database client through expire-invites.ts, so it is imported dynamically for
  // the same reason as step 4.
  let worker: WorkerHandle;
  try {
    const { registerJobs } = await import('./jobs/register.js');
    worker = await startWorker(config, logger, undefined, (boss) => registerJobs(boss, ctx, deps));
  } catch (error) {
    logger.error('worker failed to start', { ...describeError(error) });
    process.exit(EXIT_FATAL);
  }

  // Schema and pool size only: the connection string contains the password.
  logger.info('worker started', {
    schema: config.pgbossSchema,
    poolMax: config.pgbossPoolMax,
  });

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      // The operator asked twice: do not wait out the graceful path.
      process.stderr.write('worker: second signal received, exiting immediately\n');
      process.exit(EXIT_FATAL);
    }
    shuttingDown = true;
    logger.info('shutdown started', { signal });

    // A graceful stop that cannot finish must still end the process; the platform
    // is waiting to replace it.
    const watchdog = setTimeout(() => {
      logger.error('shutdown timed out', {
        timeoutMs: config.shutdownTimeoutMs + HARD_EXIT_BUFFER_MS,
      });
      process.exit(EXIT_FATAL);
    }, config.shutdownTimeoutMs + HARD_EXIT_BUFFER_MS);

    try {
      await worker.stop();
      // The client started in step 4a is the one to close: nothing else created
      // one, and the pool has to be released before the process exits.
      await db.$disconnect();
    } catch (error) {
      logger.error('shutdown failed', { ...describeError(error) });
      clearTimeout(watchdog);
      process.exit(EXIT_FATAL);
    }

    logger.info('worker stopped', { signal });
    clearTimeout(watchdog);
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch(() => {
  // The logger may not exist yet (a failure inside readConfig or createLogger).
  // No stack and no message from the error: it may quote the environment.
  process.stderr.write('worker: fatal: startup failed unexpectedly\n');
  process.exit(EXIT_FATAL);
});
