// apps/worker/src/config.ts
//
// Startup configuration for the settlement worker (ADR-0003 D5, ADR-0005).
//
// Two rules hold for everything in this file:
//   1. A configuration value is either accepted whole or rejected whole. There
//      is no "best effort" parsing: '4x' is not 4 and an empty variable is not a
//      silent default for a required one.
//   2. No error message ever contains a value. Configuration errors are printed
//      to the platform log, and DATABASE_URL carries the database password.

import { z } from 'zod';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * A configuration problem an operator can fix. The message names variables and
 * reasons only - never a value, a host, a user name or a password.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface WorkerConfig {
  databaseUrl: string;
  pgbossSchema: string;
  pgbossPoolMax: number;
  shutdownTimeoutMs: number;
  logLevel: LogLevel;
  nodeEnv: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PGBOSS_SCHEMA = 'pgboss';
const DEFAULT_PGBOSS_POOL_MAX = 4;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_NODE_ENV = 'development';

// ---------------------------------------------------------------------------
// Validation rules
// ---------------------------------------------------------------------------

/** Supabase's transaction pooler port. pg-boss must not run behind it. */
const TRANSACTION_POOLER_PORT = '6543';

/** Search parameter Supabase/pgbouncer use to request transaction pooling. */
const PGBOUNCER_PARAM = 'pgbouncer';

/** Lowercase Postgres identifier, at most 63 bytes - a schema pg-boss can own. */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** Plain decimal digits: rejects '4x', '0x10', ' 4', '+4', '1e3' and '-1'. */
const WHOLE_NUMBER_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * Rejects a database URL that is not a session-mode connection.
 *
 * pg-boss keeps session state and takes advisory locks, so Supabase's
 * transaction pooler (port 6543, or pgbouncer=true) breaks it in ways that only
 * appear under load. The direct connection is IPv6-only without the paid IPv4
 * add-on, which is why the session pooler is the supported default (ADR-0005 D2).
 *
 * @throws {ConfigError} with a value-free reason.
 */
export function assertSessionModeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError('DATABASE_URL is not a valid URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ConfigError('DATABASE_URL must be a postgres:// or postgresql:// URL');
  }
  if (parsed.hostname === '') {
    throw new ConfigError('DATABASE_URL has no host');
  }
  if (parsed.port === TRANSACTION_POOLER_PORT) {
    throw new ConfigError(
      'DATABASE_URL uses port 6543 (Supabase transaction pooler); use the session pooler on port 5432',
    );
  }
  for (const [name, value] of parsed.searchParams) {
    if (name.toLowerCase() === PGBOUNCER_PARAM && value.toLowerCase() === 'true') {
      throw new ConfigError(
        'DATABASE_URL sets pgbouncer=true (transaction pooling); use a session-mode connection',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function integerVariable(name: string, min: number, max: number) {
  const message = `${name} must be a whole number between ${min} and ${max}`;
  return z
    .string({ error: message })
    .regex(WHOLE_NUMBER_PATTERN, { error: message })
    .transform((value) => Number(value))
    .refine((value) => value >= min && value <= max, { error: message })
    .optional();
}

const envSchema = z.object({
  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }),
  PGBOSS_SCHEMA: z
    .string({ error: `PGBOSS_SCHEMA must match ${SCHEMA_NAME_PATTERN}` })
    .regex(SCHEMA_NAME_PATTERN, { error: `PGBOSS_SCHEMA must match ${SCHEMA_NAME_PATTERN}` })
    .optional(),
  PGBOSS_POOL_MAX: integerVariable('PGBOSS_POOL_MAX', 1, 10),
  SHUTDOWN_TIMEOUT_MS: integerVariable('SHUTDOWN_TIMEOUT_MS', 1_000, 120_000),
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}` }).optional(),
  NODE_ENV: z.string({ error: 'NODE_ENV must be a string' }).optional(),
});

/**
 * An empty variable is treated as unset, which is what deployment platforms
 * actually produce when an operator clears a field. A required variable that is
 * empty still fails: it is then reported as missing, never as a working value.
 */
function withoutEmptyValues(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue;
    normalized[name] = value;
  }
  return normalized;
}

/** Variable names and short reasons only. Messages contain no values. */
function formatIssues(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.message))].join('; ');
}

export function loadConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = envSchema.safeParse(withoutEmptyValues(env));
  if (!parsed.success) {
    throw new ConfigError(`Invalid worker configuration: ${formatIssues(parsed.error)}`);
  }

  const data = parsed.data;

  // The URL shape has to be checked after zod: new URL() owns the parsing rules,
  // and its error messages must never be forwarded (they echo the input).
  assertSessionModeUrl(data.DATABASE_URL);

  return {
    databaseUrl: data.DATABASE_URL,
    pgbossSchema: data.PGBOSS_SCHEMA ?? DEFAULT_PGBOSS_SCHEMA,
    pgbossPoolMax: data.PGBOSS_POOL_MAX ?? DEFAULT_PGBOSS_POOL_MAX,
    shutdownTimeoutMs: data.SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    logLevel: data.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    nodeEnv: data.NODE_ENV ?? DEFAULT_NODE_ENV,
  };
}
