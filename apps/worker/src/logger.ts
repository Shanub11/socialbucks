// apps/worker/src/logger.ts
//
// One JSON object per line, no dependency. stdout carries debug and info,
// stderr carries warn and error, so a platform can separate them by stream.
//
// Two guarantees, both of which matter more than the output format:
//   - a log call never throws, whatever is passed to it (circular graphs, BigInt,
//     throwing getters, a closed stream);
//   - a value under a sensitive key is never written. Redaction is by key name,
//     applied at every depth, because the alternative - remembering to redact at
//     every call site - fails exactly once and leaks a token forever.

import type { LogLevel } from './config';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Defaults to NODE_ENV, then 'development'. 'production' keeps stacks out of the log. */
  nodeEnv?: string;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /(pass|secret|token|authorization|cipher|key|url|cookie)/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 8;
const RESERVED_KEYS = new Set(['ts', 'level', 'msg']);

/**
 * Converts an arbitrary value into something JSON.stringify cannot choke on,
 * redacting sensitive keys and cutting circular references.
 */
function serialize(value: unknown, depth: number, seen: WeakSet<object>, includeStack: boolean): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'symbol':
      return value.toString();
    case 'function':
      return '[function]';
    case 'undefined':
      return undefined;
    default:
      break;
  }

  if (value instanceof Error) {
    const serialized: Record<string, unknown> = { name: value.name, message: value.message };
    if (includeStack && typeof value.stack === 'string') serialized.stack = value.stack;
    return serialized;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? 'Invalid Date' : value.toISOString();
  }

  if (depth >= MAX_DEPTH) return '[max depth]';

  const object = value as object;
  if (seen.has(object)) return '[circular]';
  seen.add(object);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => serialize(item, depth + 1, seen, includeStack));
    }

    const serialized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(object as Record<string, unknown>)) {
      serialized[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : serialize(nested, depth + 1, seen, includeStack);
    }
    return serialized;
  } finally {
    // Only the current path is circular; the same object twice side by side is not.
    seen.delete(object);
  }
}

function writeLine(stream: 'stdout' | 'stderr', line: string): void {
  try {
    if (stream === 'stderr') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  } catch {
    // A logger that takes the process down when the log pipe closes is worse
    // than a lost line.
  }
}

function createLevelLogger(threshold: number, baseFields: LogFields, includeStack: boolean): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;

    let line: string;
    try {
      const timestamp = new Date().toISOString();
      const payload: Record<string, unknown> = { ts: timestamp, level, msg };
      const merged: LogFields = { ...baseFields, ...(fields ?? {}) };

      for (const [key, value] of Object.entries(merged)) {
        // Reserved keys are owned by the logger: a field must never be able to
        // rewrite the timestamp, level or message of the line it travels in.
        if (RESERVED_KEYS.has(key)) continue;
        payload[key] = SENSITIVE_KEY.test(key) ? REDACTED : serialize(value, 0, new WeakSet(), includeStack);
      }

      line = `${JSON.stringify(payload)}\n`;
    } catch {
      // Serialization itself failed (a throwing getter, for example). Report the
      // failure, not the data that caused it.
      line = `${JSON.stringify({ ts: new Date().toISOString(), level, msg: 'log serialization failed' })}\n`;
    }

    writeLine(level === 'warn' || level === 'error' ? 'stderr' : 'stdout', line);
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLevelLogger(threshold, { ...baseFields, ...fields }, includeStack),
  };
}

export function createLogger(level: LogLevel, options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  return createLevelLogger(threshold, {}, nodeEnv !== 'production');
}
