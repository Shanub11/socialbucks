// apps/worker/src/test-support/recording-logger.ts
//
// A Logger that keeps what it was given, so a test can assert on structure
// (level, message, fields) instead of scraping stdout.
//
// It does not redact and it does not serialize: a test that asserts a secret is
// absent needs to see exactly what a job passed to the logger.

import type { LogFields, Logger } from '../logger';

export type RecordedLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RecordedLog {
  level: RecordedLevel;
  msg: string;
  fields: LogFields;
}

export interface RecordingLogger {
  logger: Logger;
  entries: RecordedLog[];
  /** Everything recorded, as one string: for "this value never appears" checks. */
  text(): string;
  /** The entries at one level, in call order. */
  at(level: RecordedLevel): RecordedLog[];
}

export function createRecordingLogger(): RecordingLogger {
  const entries: RecordedLog[] = [];

  const record = (level: RecordedLevel) => (msg: string, fields?: LogFields): void => {
    entries.push({ level, msg, fields: fields ?? {} });
  };

  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    // The tests never assert on child bindings; a child behaves like its parent.
    child: () => logger,
  };

  return {
    logger,
    entries,
    text: () => JSON.stringify(entries),
    at: (level) => entries.filter((entry) => entry.level === level),
  };
}
