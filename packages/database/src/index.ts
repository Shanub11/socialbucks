import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

/**
 * Which kind of process is building the client.
 *
 * - `default` - the web app. Behaviour unchanged: Prisma's query/error/warn
 *   logging in development, error-only otherwise, no pool options.
 * - `worker`  - apps/worker. Prisma logs nothing at all (ADR-0006 D9), because
 *   Prisma writes its own output straight to the process streams - outside the
 *   worker's logger and its key-based redaction - and a connect timeout is set
 *   explicitly instead of waiting for the OS default.
 */
export type ClientProfile = 'default' | 'worker';

/** How long the `worker` profile waits for a connection. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The `log` option for a profile.
 *
 * A function rather than three inline ternaries so the rule is testable without
 * building a client, and so "the worker prints nothing" is one line in code
 * instead of a convention someone has to remember.
 */
export function resolveLogOptions(
  profile: ClientProfile,
  nodeEnv: string | undefined,
): ('query' | 'info' | 'warn' | 'error')[] {
  // Nothing. Failures still surface as thrown errors, which the caller logs by
  // name and code; what stops here is Prisma's own printing, which quotes the
  // database user, host and port (and, with 'query', SQL and its parameters).
  if (profile === 'worker') return [];
  return nodeEnv === 'development' ? ['query', 'error', 'warn'] : ['error'];
}

export interface CreatePrismaClientOptions {
  connectionString: string | undefined;
  /** Defaults to 'default', which is the web app's behaviour. */
  profile?: ClientProfile;
  /** `worker` profile only. Defaults to 10 s. */
  connectTimeoutMs?: number;
}

/**
 * Builds a Prisma client. It never connects: the pg pool inside the adapter opens
 * a connection on first use, so a client that is built and never queried holds no
 * socket and no timer.
 *
 * The connection string is passed in and never read from, copied or logged here.
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const profile = options.profile ?? 'default';

  const adapter = new PrismaPg(
    profile === 'worker'
      ? {
          connectionString: options.connectionString,
          // pg's own pool option (pg.PoolConfig). Without it a connect attempt
          // waits for the OS default, measured at 23 s against an unroutable
          // host - long enough to look like a hang rather than a failure.
          connectionTimeoutMillis: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        }
      : { connectionString: options.connectionString },
  );

  return new PrismaClient({
    adapter,
    log: resolveLogOptions(profile, process.env.NODE_ENV),
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * The web app's singleton. Unchanged: the same log arrays for the same NODE_ENV
 * values, the same adapter options, the same caching condition, built at import.
 *
 * The worker does not use it - it calls createPrismaClient with the 'worker'
 * profile - but importing this package still builds it, so it stays lazy (see
 * createPrismaClient).
 */
export const prisma =
  globalForPrisma.prisma ??
  createPrismaClient({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export * from './generated/prisma/client';
