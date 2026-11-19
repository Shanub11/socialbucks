// apps/worker/src/config.test.ts
//
// Pure tests for startup configuration: no database, no network, no env var
// reads. Every rejection is checked twice - once for the reason, and once for
// the rule that a ConfigError never echoes the value that caused it.

import { describe, expect, it } from 'vitest';

import { assertSessionModeUrl, ConfigError, loadConfig, LOG_LEVELS } from './config';

const SESSION_URL = 'postgres://worker:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
const LOCAL_TEST_URL = 'postgres://postgres:postgres@localhost:5432/socialbucks_test';

/**
 * The password and host every rejected URL carries. No ConfigError message may
 * contain either: these errors are printed to the platform log.
 */
const CANARY_PASSWORD = 'CANARY_pw_91d';
const CANARY_HOST = 'canary-host.example';
const CANARY_MARKER = 'CANARY';

function canaryUrl(query = '', port = '5432'): string {
  return `postgres://worker:${CANARY_PASSWORD}@${CANARY_HOST}:${port}/socialbucks${query}`;
}

/** Each form Supabase can use to ask for transaction pooling. */
const REJECTED_URL_FORMS: Array<[label: string, query: string, port: string]> = [
  ['port 6543 (transaction pooler)', '', '6543'],
  ['pgbouncer=true', '?pgbouncer=true', '5432'],
  ['PGBOUNCER=TRUE', '?PGBOUNCER=TRUE', '5432'],
];

/**
 * Runs `run` expecting a ConfigError, then asserts the message is value-free.
 * Returns the message so a test can check the reason it cares about.
 */
function captureConfigError(run: () => unknown): string {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ConfigError);
  const message = (caught as ConfigError).message;

  expect(message).not.toContain(CANARY_PASSWORD);
  expect(message).not.toContain(CANARY_HOST);
  expect(message).not.toMatch(new RegExp(CANARY_MARKER, 'i'));

  return message;
}

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig({ DATABASE_URL: SESSION_URL });

    expect(config).toEqual({
      databaseUrl: SESSION_URL,
      pgbossSchema: 'pgboss',
      pgbossPoolMax: 4,
      shutdownTimeoutMs: 30_000,
      logLevel: 'info',
      nodeEnv: 'development',
    });
  });

  it('accepts every override', () => {
    const config = loadConfig({
      DATABASE_URL: SESSION_URL,
      PGBOSS_SCHEMA: 'pgboss_blue',
      PGBOSS_POOL_MAX: '10',
      SHUTDOWN_TIMEOUT_MS: '1000',
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
    });

    expect(config).toEqual({
      databaseUrl: SESSION_URL,
      pgbossSchema: 'pgboss_blue',
      pgbossPoolMax: 10,
      shutdownTimeoutMs: 1_000,
      logLevel: 'debug',
      nodeEnv: 'production',
    });
  });

  it('treats an empty optional variable as unset', () => {
    const config = loadConfig({
      DATABASE_URL: SESSION_URL,
      PGBOSS_SCHEMA: '',
      PGBOSS_POOL_MAX: '',
      SHUTDOWN_TIMEOUT_MS: '',
      LOG_LEVEL: '',
      NODE_ENV: '',
    });

    expect(config.pgbossSchema).toBe('pgboss');
    expect(config.pgbossPoolMax).toBe(4);
    expect(config.shutdownTimeoutMs).toBe(30_000);
    expect(config.logLevel).toBe('info');
    expect(config.nodeEnv).toBe('development');
  });

  it.each([
    ['0', 'below the minimum'],
    ['11', 'above the maximum'],
    ['abc', 'not a number'],
    ['4x', 'not a whole number'],
  ])('rejects PGBOSS_POOL_MAX %s (%s)', (value) => {
    const message = captureConfigError(() =>
      loadConfig({ DATABASE_URL: canaryUrl(), PGBOSS_POOL_MAX: value }),
    );

    expect(message).toContain('PGBOSS_POOL_MAX');
    expect(message).toContain('1');
    expect(message).toContain('10');
  });

  it.each([
    ['999', 'below the minimum'],
    ['120001', 'above the maximum'],
  ])('rejects SHUTDOWN_TIMEOUT_MS %s (%s)', (value) => {
    const message = captureConfigError(() =>
      loadConfig({ DATABASE_URL: canaryUrl(), SHUTDOWN_TIMEOUT_MS: value }),
    );

    expect(message).toContain('SHUTDOWN_TIMEOUT_MS');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    const message = captureConfigError(() =>
      loadConfig({ DATABASE_URL: canaryUrl(), LOG_LEVEL: 'verbose' }),
    );

    expect(message).toContain('LOG_LEVEL');
    for (const level of LOG_LEVELS) {
      expect(message).toContain(level);
    }
  });

  it.each([
    ['Pgboss', 'uppercase'],
    ['pg-boss', 'a dash'],
    ['pgboss;drop schema', 'a semicolon'],
    ['a'.repeat(64), '64 characters'],
  ])('rejects PGBOSS_SCHEMA with %s (%s)', (value) => {
    const message = captureConfigError(() =>
      loadConfig({ DATABASE_URL: canaryUrl(), PGBOSS_SCHEMA: value }),
    );

    expect(message).toContain('PGBOSS_SCHEMA');
    // The invalid value itself is never echoed back.
    expect(message).not.toContain(value);
  });

  it('rejects a missing DATABASE_URL', () => {
    const message = captureConfigError(() => loadConfig({}));

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('required');
  });

  it.each(REJECTED_URL_FORMS)('rejects a URL with %s', (_label, query, port) => {
    const message = captureConfigError(() =>
      loadConfig({ DATABASE_URL: canaryUrl(query, port) }),
    );

    expect(message).toContain('DATABASE_URL');
  });

  it('accepts the session pooler on 5432 and a localhost test URL', () => {
    expect(() => loadConfig({ DATABASE_URL: SESSION_URL })).not.toThrow();
    expect(() => loadConfig({ DATABASE_URL: LOCAL_TEST_URL })).not.toThrow();
  });
});

describe('assertSessionModeUrl', () => {
  it.each(REJECTED_URL_FORMS)('rejects a URL with %s', (_label, query, port) => {
    const message = captureConfigError(() => assertSessionModeUrl(canaryUrl(query, port)));

    expect(message).toContain('DATABASE_URL');
  });

  it('accepts session-mode URLs', () => {
    expect(() => assertSessionModeUrl(SESSION_URL)).not.toThrow();
    expect(() => assertSessionModeUrl(LOCAL_TEST_URL)).not.toThrow();
    expect(() => assertSessionModeUrl(canaryUrl())).not.toThrow();
    expect(() => assertSessionModeUrl(canaryUrl('?pgbouncer=false'))).not.toThrow();
  });
});
