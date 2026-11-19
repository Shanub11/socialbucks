// apps/worker/src/logger.test.ts
//
// Pure tests for the structured logger: output shape, stream routing, level
// filtering, redaction and the promise that a log call never throws.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from './logger';

function captureStreams() {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  const written = (spy: typeof stdout): string[] => spy.mock.calls.map((call) => String(call[0]));

  return {
    stdoutLines: () => written(stdout),
    stderrLines: () => written(stderr),
  };
}

function parseLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('writes exactly one JSON line per call', () => {
    const capture = captureStreams();
    const log = createLogger('debug', { nodeEnv: 'development' });

    log.info('hello', { slotId: 'slot_1', attempt: 2 });

    const lines = capture.stdoutLines();
    expect(lines).toHaveLength(1);

    const line = lines[0]!;
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);

    const payload = JSON.parse(line) as Record<string, unknown>;
    expect(payload.msg).toBe('hello');
    expect(payload.level).toBe('info');
    expect(payload.slotId).toBe('slot_1');
    expect(payload.attempt).toBe(2);
    expect(typeof payload.ts).toBe('string');
    expect(Number.isNaN(Date.parse(String(payload.ts)))).toBe(false);
  });

  it('routes debug and info to stdout, warn and error to stderr', () => {
    const capture = captureStreams();
    const log = createLogger('debug', { nodeEnv: 'development' });

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(parseLines(capture.stdoutLines()).map((line) => line.level)).toEqual(['debug', 'info']);
    expect(parseLines(capture.stderrLines()).map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('drops records below the configured level', () => {
    const capture = captureStreams();
    const log = createLogger('warn', { nodeEnv: 'development' });

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(capture.stdoutLines()).toHaveLength(0);
    expect(parseLines(capture.stderrLines()).map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('redacts sensitive keys at every depth and keeps ordinary keys', () => {
    const capture = captureStreams();
    const log = createLogger('info', { nodeEnv: 'development' });

    log.info('secrets', {
      slotId: 'slot_1',
      password: 'pw',
      accessToken: 'access',
      DATABASE_URL: 'postgres://user:pw@host:5432/db',
      Authorization: 'Bearer abc',
      tokenCiphertext: 'cipher',
      nested: {
        clientSecret: 'shh',
        cookieHeader: 'session=1',
        keepMe: 'visible',
        deeper: [{ apiKey: 'k', count: 3 }],
      },
      list: ['plain', { refreshToken: 'r' }],
    });

    const [payload] = parseLines(capture.stdoutLines());
    expect(payload).toBeDefined();

    expect(payload!.slotId).toBe('slot_1');
    expect(payload!.password).toBe('[redacted]');
    expect(payload!.accessToken).toBe('[redacted]');
    expect(payload!.DATABASE_URL).toBe('[redacted]');
    expect(payload!.Authorization).toBe('[redacted]');
    expect(payload!.tokenCiphertext).toBe('[redacted]');

    const nested = payload!.nested as Record<string, unknown>;
    expect(nested.clientSecret).toBe('[redacted]');
    expect(nested.cookieHeader).toBe('[redacted]');
    expect(nested.keepMe).toBe('visible');

    const deeper = (nested.deeper as Array<Record<string, unknown>>)[0]!;
    expect(deeper.apiKey).toBe('[redacted]');
    expect(deeper.count).toBe(3);

    expect(payload!.list).toEqual(['plain', { refreshToken: '[redacted]' }]);
  });

  it('serializes an Error to name and message only in production', () => {
    const capture = captureStreams();
    const log = createLogger('error', { nodeEnv: 'production' });

    log.error('failed', { error: new Error('boom') });

    const [payload] = parseLines(capture.stderrLines());
    expect(payload!.error).toEqual({ name: 'Error', message: 'boom' });
  });

  it('keeps the stack outside production', () => {
    const capture = captureStreams();
    const log = createLogger('error', { nodeEnv: 'development' });

    log.error('failed', { error: new Error('boom') });

    const [payload] = parseLines(capture.stderrLines());
    const error = payload!.error as Record<string, unknown>;
    expect(error.name).toBe('Error');
    expect(error.message).toBe('boom');
    expect(String(error.stack)).toContain('boom');
  });

  it('never throws on a circular object', () => {
    const capture = captureStreams();
    const log = createLogger('info', { nodeEnv: 'development' });

    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() => log.info('circular', { circular })).not.toThrow();

    const [payload] = parseLines(capture.stdoutLines());
    const serialized = payload!.circular as Record<string, unknown>;
    expect(serialized.name).toBe('loop');
    expect(serialized.self).toBe('[circular]');
  });

  it('merges child fields and inherits the level threshold', () => {
    const capture = captureStreams();
    const log = createLogger('warn', { nodeEnv: 'development' }).child({ component: 'settlement' });

    log.info('dropped');
    log.warn('kept', { slotId: 'slot_1' });

    expect(capture.stdoutLines()).toHaveLength(0);
    const [payload] = parseLines(capture.stderrLines());
    expect(payload!.component).toBe('settlement');
    expect(payload!.slotId).toBe('slot_1');
  });
});
