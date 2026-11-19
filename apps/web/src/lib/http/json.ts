// apps/web/src/lib/http/json.ts
//
// Shared request-parsing helpers for the product API.
//
// Every helper returns a discriminated result so a route handler either gets
// validated data or a ready-to-return NextResponse — there is no third state
// where a handler might continue with unvalidated input.
//
// Validation responses never echo submitted values: only field paths and
// schema messages, so a rejected body cannot be reflected back to the caller.

import { NextResponse } from 'next/server';
import { z } from 'zod';

export const MAX_JSON_BODY_BYTES = 16 * 1024;

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

type CappedRead =
  | { kind: 'ok'; text: string }
  | { kind: 'too_large' }
  | { kind: 'invalid_encoding' };

/** JSON response that must never be cached by a browser, CDN or proxy. */
export function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/** 400 with field paths and messages only. Never echoes input values. */
export function validationErrorResponse(error: z.ZodError): NextResponse {
  return noStoreJson(
    {
      error: 'Invalid request',
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    },
    400,
  );
}

async function readCappedText(req: Request, maxBytes: number): Promise<CappedRead> {
  if (!req.body) return { kind: 'ok', text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { kind: 'too_large' };
    }
    chunks.push(value);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return { kind: 'ok', text };
  } catch {
    return { kind: 'invalid_encoding' };
  }
}

/**
 * Parses and validates a JSON request body.
 * 415 wrong/missing content-type, 413 over maxBytes (declared or actual),
 * 400 invalid UTF-8 / invalid JSON / schema failure.
 */
export async function parseJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<ParseResult<z.output<S>>> {
  const contentType = (req.headers.get('content-type') ?? '').trim();
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    return { ok: false, response: noStoreJson({ error: 'Content-Type must be application/json' }, 415) };
  }

  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      return { ok: false, response: noStoreJson({ error: 'Request body too large' }, 413) };
    }
  }

  const read = await readCappedText(req, maxBytes);
  if (read.kind === 'too_large') {
    return { ok: false, response: noStoreJson({ error: 'Request body too large' }, 413) };
  }
  if (read.kind === 'invalid_encoding') {
    return { ok: false, response: noStoreJson({ error: 'Invalid JSON' }, 400) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return { ok: false, response: noStoreJson({ error: 'Invalid JSON' }, 400) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, response: validationErrorResponse(result.error) };
  }
  return { ok: true, data: result.data };
}

/** Validates URL query params. Duplicate keys are rejected (400). */
export function parseQuery<S extends z.ZodType>(
  req: Request,
  schema: S,
): ParseResult<z.output<S>> {
  const entries = [...new URL(req.url).searchParams.entries()];
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) {
    return { ok: false, response: noStoreJson({ error: 'Duplicate query parameter' }, 400) };
  }
  const result = schema.safeParse(Object.fromEntries(entries));
  if (!result.success) {
    return { ok: false, response: validationErrorResponse(result.error) };
  }
  return { ok: true, data: result.data };
}
