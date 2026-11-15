// apps/worker/src/main.ts
//
// Entry point for the settlement worker host (ADR-0003 D5, ADR-0005).
//
// Stage 1 is host plumbing only: configuration, structured logging, the pg-boss
// connection and graceful shutdown. There is deliberately no business logic, no
// HTTP server and no listening port - the process consumes work and its health is
// observed through the platform and the logs.

import { ConfigError, loadConfig, type WorkerConfig } from './config';
import { createLogger, type Logger } from './logger';
import { startWorker, type WorkerHandle } from './worker';

/** 2 is "configuration is wrong"; 1 is "everything else". */
const EXIT_CONFIG_ERROR = 2;
const EXIT_FATAL = 1;

/** Slack on top of the graceful-stop timeout before the process is forced down. */
const HARD_EXIT_BUFFER_MS = 5_000;

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
 * Last resort for failures outside the request/shutdown paths. The platform
 * restarts the service, so the only job here is to exit non-zero with a line
 * that says what happened.
 */
function installFatalHandlers(logger: Logger): void {
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { error });
    process.exit(EXIT_FATAL);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { error: reason });
    process.exit(EXIT_FATAL);
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel, { nodeEnv: config.nodeEnv });

  installFatalHandlers(logger);

  let worker: WorkerHandle;
  try {
    worker = await startWorker(config, logger);
  } catch (error) {
    logger.error('worker failed to start', { error });
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
      // Imported here rather than at module load: the Prisma singleton reads
      // process.env.DATABASE_URL as it is created, so configuration has to be
      // validated (and the logger ready) before anything imports it.
      const { prisma } = await import('@repo/database');
      await prisma.$disconnect();
    } catch (error) {
      logger.error('shutdown failed', { error });
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
