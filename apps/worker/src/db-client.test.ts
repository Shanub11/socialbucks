// apps/worker/src/db-client.test.ts
//
// The worker's database client must not print anything of its own (ADR-0006 D9).
// Prisma writes straight to the process streams, outside the worker's logger and
// its key-based redaction, and on a rejected login it quotes the database user
// and host:port.
//
// Pure: no database is needed, and nothing here reads DATABASE_URL or
// TEST_DATABASE_URL. Every connection string below is deliberately unreachable -
// the failure is the subject of the test.
//
// (b) is the real assertion. (c) is its control: if the capture ever stopped
// working, (b) would pass for the wrong reason, so the same scenario must be seen
// printing under the profile that does log.

import { createPrismaClient, resolveLogOptions } from '@repo/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Loopback, port 1: the connection is refused immediately. */
const REFUSED_URL = 'postgres://u:CANARY_pw_91d@127.0.0.1:1/db';

/** No route to this address, so a connect attempt can only end in its timeout. */
const UNROUTABLE_URL = 'postgres://u:p@10.255.255.1:5432/db';

const CANARY_PASSWORD = 'CANARY_pw_91d';

interface Captured {
  text(): string;
  restore(): void;
}

/**
 * Records everything the process could print. Writes are suppressed as well as
 * recorded: a leak must not reach the CI log merely because a test was watching
 * for it.
 */
function captureProcessOutput(): Captured {
  const chunks: string[] = [];
  const record = (value: unknown): void => {
    chunks.push(typeof value === 'string' ? value : String(value));
  };

  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      record(chunk);
      return true;
    }) as never),
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      record(chunk);
      return true;
    }) as never),
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      record(args.map(String).join(' '));
    }),
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      record(args.map(String).join(' '));
    }),
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      record(args.map(String).join(' '));
    }),
  ];

  return {
    text: () => chunks.join(''),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** Lets output Prisma buffers flush into the capture before the spies go away. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveLogOptions', () => {
  it.each([
    { profile: 'default' as const, nodeEnv: 'development', expected: ['query', 'error', 'warn'] },
    { profile: 'default' as const, nodeEnv: 'production', expected: ['error'] },
    { profile: 'default' as const, nodeEnv: undefined, expected: ['error'] },
    { profile: 'worker' as const, nodeEnv: 'development', expected: [] },
    { profile: 'worker' as const, nodeEnv: 'production', expected: [] },
    { profile: 'worker' as const, nodeEnv: undefined, expected: [] },
  ])('$profile profile in $nodeEnv', ({ profile, nodeEnv, expected }) => {
    expect(resolveLogOptions(profile, nodeEnv)).toEqual(expected);
  });
});

describe('the worker profile prints nothing of its own', () => {
  it('writes no prisma:error block and no part of the connection string when the connection is refused', async () => {
    const capture = captureProcessOutput();
    const client = createPrismaClient({ connectionString: REFUSED_URL, profile: 'worker' });

    try {
      await expect(client.$queryRaw`SELECT 1`).rejects.toBeInstanceOf(Error);
      await settle();
    } finally {
      await client.$disconnect().catch(() => undefined);
      capture.restore();
    }

    const output = capture.text();
    expect(output).not.toContain('prisma:error');
    expect(output).not.toContain(CANARY_PASSWORD);
    expect(output).not.toContain('127.0.0.1');
    // A one-letter user name cannot be asserted on its own without matching every
    // string, so the userinfo form is asserted instead.
    expect(output).not.toContain('u:CANARY_pw_91d');
  });

  it('control: the default profile does print prisma:error, so the silence above is real', async () => {
    const capture = captureProcessOutput();
    const client = createPrismaClient({ connectionString: REFUSED_URL, profile: 'default' });

    try {
      await expect(client.$queryRaw`SELECT 1`).rejects.toBeInstanceOf(Error);
      await settle();
    } finally {
      await client.$disconnect().catch(() => undefined);
      capture.restore();
    }

    // Captured, not printed: the spies suppressed the block. If this assertion
    // ever fails, the capture is broken - report it rather than relaxing the test
    // above.
    expect(capture.text()).toContain('prisma:error');
  });

  it(
    'gives up on an unroutable host within the configured connect timeout',
    async () => {
      const client = createPrismaClient({
        connectionString: UNROUTABLE_URL,
        profile: 'worker',
        connectTimeoutMs: 500,
      });

      const startedAt = performance.now();
      try {
        await expect(client.$queryRaw`SELECT 1`).rejects.toBeInstanceOf(Error);
      } finally {
        await client.$disconnect().catch(() => undefined);
      }
      const elapsedMs = performance.now() - startedAt;

      // Whether the network drops the packets or rejects the address outright, the
      // wait is bounded by the pool's connect timeout, not by the OS default.
      expect(elapsedMs).toBeLessThan(5_000);
    },
    15_000,
  );
});

describe('client construction', () => {
  it('does not connect on construction: a refused URL prints nothing until a query runs', async () => {
    const capture = captureProcessOutput();
    // 'default' on purpose: this profile does log, so if construction opened a
    // connection the refusal would be printed and captured here.
    const client = createPrismaClient({ connectionString: REFUSED_URL, profile: 'default' });

    try {
      await settle();
      expect(capture.text()).not.toContain('prisma:error');
      expect(capture.text()).not.toContain(CANARY_PASSWORD);
    } finally {
      await client.$disconnect().catch(() => undefined);
      capture.restore();
    }
  });
});
