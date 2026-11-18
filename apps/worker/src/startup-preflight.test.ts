// apps/worker/src/startup-preflight.test.ts
//
// The startup order, observed from outside the process.
//
// These tests spawn the real entry point (`src/main.ts`, through the installed
// tsx loader, from apps/worker) with an explicit environment, and read its exit
// code and streams. That matters for two reasons an in-process test cannot
// cover:
//
//   - the settlement preflight must run BEFORE the database, so a missing
//     YouTube variable exits 2 even though DATABASE_URL is unreachable;
//   - the worker profile's silence is only meaningful if it holds for a real
//     child process's stderr, not just for spies installed in this one.
//
// The child never inherits this process's environment: it gets an allow-list of
// what Node and tsx need to run, plus exactly the variables under test. A stray
// DATABASE_URL or key in the shell cannot change what these tests assert.
//
// No database is contacted. Cases (a)-(c) exit in the preflight, before any
// client is built; case (d) points at 127.0.0.1:1, where the connection is
// refused immediately.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** apps/worker: the same cwd the `start` script runs from. */
const WORKER_DIR = path.resolve(HERE, '..');
const ENTRY = 'src/main.ts';
const TIMEOUT_MS = 20_000;

/** A valid session-mode URL whose port refuses connections immediately. */
const REFUSED_DATABASE_URL = 'postgres://u:CANARY_pw_91d@127.0.0.1:1/db';

/** 32 fixed bytes, base64: shape-valid keys that are not secrets. */
const YOUTUBE_KEY = Buffer.alloc(32, 0x11).toString('base64');
const INSTAGRAM_KEY = Buffer.alloc(32, 0x22).toString('base64');

const VALID_SETTLEMENT_ENV: Record<string, string> = {
  YOUTUBE_CLIENT_ID: 'test-client-id',
  YOUTUBE_CLIENT_SECRET: 'test-client-secret',
  YOUTUBE_REDIRECT_URI: 'https://example.test/auth/youtube',
  YOUTUBE_TOKEN_ENCRYPTION_KEY: YOUTUBE_KEY,
};

/** The installed tsx loader, the documented way to run TypeScript under node. */
function tsxLoaderUrl(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve('tsx/package.json');
  const loader = path.join(path.dirname(packageJson), 'dist', 'loader.mjs');

  if (!existsSync(loader)) {
    throw new Error('[startup-preflight] the installed tsx loader is missing');
  }

  return pathToFileURL(loader).href;
}

/**
 * Only what Node and tsx need to start on this platform. Everything else -
 * DATABASE_URL, PGBOSS_*, LOG_LEVEL, NODE_ENV from the outer shell - is
 * deliberately absent, so the child's behaviour is a function of the case.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };

  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

async function runEntry(extraEnv: Record<string, string>): Promise<RunResult> {
  const loaderUrl = tsxLoaderUrl();

  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loaderUrl, ENTRY], {
      cwd: WORKER_DIR,
      env: { ...baseEnv(), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(
          new Error(
            `[startup-preflight] the entry did not exit within ${TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        ),
      );
    }, TIMEOUT_MS);

    child.on('error', (error: Error) => {
      finish(() => reject(error));
    });

    child.on('close', (code: number | null) => {
      finish(() => resolve({ code, stdout, stderr, combined: `${stdout}${stderr}` }));
    });
  });
}

// ---------------------------------------------------------------------------
// (a) nothing configured
// ---------------------------------------------------------------------------

describe('startup preflight (a): no settlement variables', () => {
  it('exits 2 with the four variable names, no stack and no URL', async () => {
    const result = await runEntry({ DATABASE_URL: REFUSED_DATABASE_URL });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('YOUTUBE_CLIENT_ID');
    expect(result.stderr).toContain('YOUTUBE_CLIENT_SECRET');
    expect(result.stderr).toContain('YOUTUBE_REDIRECT_URI');
    expect(result.stderr).toContain('YOUTUBE_TOKEN_ENCRYPTION_KEY');

    // A stack would name files; a URL would leak the credential.
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr).not.toContain('postgres://');
    expect(result.combined).not.toContain('CANARY');
    expect(result.combined).not.toContain('127.0.0.1');
  }, TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// (b) the two platform keys must differ
// ---------------------------------------------------------------------------

describe('startup preflight (b): one key for both platforms', () => {
  it('exits 2 naming YOUTUBE_TOKEN_ENCRYPTION_KEY and never the key', async () => {
    const result = await runEntry({
      DATABASE_URL: REFUSED_DATABASE_URL,
      ...VALID_SETTLEMENT_ENV,
      INSTAGRAM_TOKEN_ENCRYPTION_KEY: YOUTUBE_KEY,
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('YOUTUBE_TOKEN_ENCRYPTION_KEY');
    expect(result.stderr).not.toMatch(/\n\s+at /);
    // Neither key value may appear: a malformed key is still a secret.
    expect(result.combined).not.toContain(YOUTUBE_KEY);
    expect(result.combined).not.toContain(INSTAGRAM_KEY);
    expect(result.combined).not.toContain('postgres://');
  }, TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// (c) a malformed value never reaches the log
// ---------------------------------------------------------------------------

describe('startup preflight (c): malformed values carry canaries', () => {
  it('exits 2 without printing either canary', async () => {
    const result = await runEntry({
      DATABASE_URL: REFUSED_DATABASE_URL,
      YOUTUBE_CLIENT_ID: 'CANARY_id_8d2',
      YOUTUBE_CLIENT_SECRET: 'test-client-secret',
      YOUTUBE_REDIRECT_URI: 'CANARY_id_8d2',
      YOUTUBE_TOKEN_ENCRYPTION_KEY: 'CANARY_key_3fa',
    });

    expect(result.code).toBe(2);
    expect(result.combined).not.toContain('CANARY_key_3fa');
    expect(result.combined).not.toContain('CANARY_id_8d2');
    // The variables are named; the values are not.
    expect(result.stderr).toContain('YOUTUBE_REDIRECT_URI');
    expect(result.stderr).toContain('YOUTUBE_TOKEN_ENCRYPTION_KEY');
  }, TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// (d) valid environment, unreachable database
// ---------------------------------------------------------------------------

describe('startup preflight (d): valid settlement environment, refused database', () => {
  it('exits 1 with the fixed database line and no Prisma output or credential', async () => {
    const result = await runEntry({
      DATABASE_URL: REFUSED_DATABASE_URL,
      ...VALID_SETTLEMENT_ENV,
      INSTAGRAM_TOKEN_ENCRYPTION_KEY: INSTAGRAM_KEY,
    });

    expect(result.code).toBe(1);
    expect(result.combined).toContain('database client failed to initialise');
    expect(result.combined).not.toContain('prisma:error');
    expect(result.combined).not.toContain('CANARY');
    expect(result.combined).not.toContain('127.0.0.1');
  }, TIMEOUT_MS);
});
