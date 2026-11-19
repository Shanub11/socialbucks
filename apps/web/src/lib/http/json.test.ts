// apps/web/src/lib/http/json.test.ts
//
// Pure unit tests for the shared request helpers: no database, no Clerk, no
// Next.js runtime, so these always run (they are NOT gated on RUN_DB_TESTS).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  MAX_JSON_BODY_BYTES,
  noStoreJson,
  parseJsonBody,
  parseQuery,
} from './json';

const BodySchema = z.strictObject({ name: z.string().min(1) });

function postRequest(
  body: BodyInit | null,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers,
    body,
  });
}

function getRequest(query: string): Request {
  return new Request(`http://localhost/api/test${query}`);
}

describe('noStoreJson', () => {
  it('sets the status and a no-store Cache-Control header', async () => {
    const response = noStoreJson({ ok: true }, 201);

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('parseJsonBody', () => {
  it('parses and validates a well-formed JSON body', async () => {
    const result = await parseJsonBody(
      postRequest(JSON.stringify({ name: 'Acme' })),
      BodySchema,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the body to parse');
    expect(result.data).toEqual({ name: 'Acme' });
  });

  it('accepts an application/json content-type with a charset parameter', async () => {
    const result = await parseJsonBody(
      postRequest(JSON.stringify({ name: 'Acme' }), {
        'content-type': 'application/json; charset=utf-8',
      }),
      BodySchema,
    );

    expect(result.ok).toBe(true);
  });

  it('returns 415 when content-type is missing entirely', async () => {
    // A string body would get an automatic text/plain content-type from the
    // fetch primitives, so use raw bytes to model a genuinely headerless body.
    const request = postRequest(
      new TextEncoder().encode(JSON.stringify({ name: 'Acme' })),
      {},
    );
    expect(request.headers.get('content-type')).toBeNull();

    const result = await parseJsonBody(request, BodySchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(415);
    expect(await result.response.json()).toEqual({
      error: 'Content-Type must be application/json',
    });
  });

  it('returns 415 for a non-JSON content-type', async () => {
    const result = await parseJsonBody(
      postRequest(JSON.stringify({ name: 'Acme' }), {
        'content-type': 'text/plain',
      }),
      BodySchema,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(415);
  });

  it('returns 413 when content-length declares more than the limit', async () => {
    const request = postRequest('{}', {
      'content-type': 'application/json',
      'content-length': String(MAX_JSON_BODY_BYTES + 1),
    });
    // The header must survive construction for this test to mean anything.
    expect(request.headers.get('content-length')).toBe(
      String(MAX_JSON_BODY_BYTES + 1),
    );

    const result = await parseJsonBody(request, BodySchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(413);
    expect(await result.response.json()).toEqual({
      error: 'Request body too large',
    });
  });

  it('returns 413 for an oversized streamed body with no content-length header', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('x'.repeat(MAX_JSON_BODY_BYTES + 1)),
        );
        controller.close();
      },
    });
    const init: RequestInit & { duplex?: 'half' } = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // Node requires duplex for a streamed request body.
      duplex: 'half',
    };
    const request = new Request('http://localhost/api/test', init);
    expect(request.headers.get('content-length')).toBeNull();

    const result = await parseJsonBody(request, BodySchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(413);
  });

  it('returns 400 for malformed JSON', async () => {
    const result = await parseJsonBody(postRequest('{not json'), BodySchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: 'Invalid JSON' });
  });

  it('returns 400 for an empty body', async () => {
    const result = await parseJsonBody(
      postRequest(null, { 'content-type': 'application/json' }),
      BodySchema,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: 'Invalid JSON' });
  });

  it('returns 400 for invalid UTF-8 bytes', async () => {
    const result = await parseJsonBody(
      postRequest(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d])),
      BodySchema,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: 'Invalid JSON' });
  });

  it('returns 400 with field paths and never echoes the submitted value', async () => {
    const submitted = 'do-not-echo-this-0123456789';
    const result = await parseJsonBody(
      postRequest(JSON.stringify({ name: 42, nested: submitted })),
      BodySchema,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(400);

    const raw = await result.response.text();
    expect(raw).not.toContain(submitted);

    const body: {
      error: string;
      issues: Array<{ path: string; message: string }>;
    } = JSON.parse(raw);
    expect(body.error).toBe('Invalid request');
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues.some((issue) => issue.path === 'name')).toBe(true);
    // Unknown key is reported in the message, not by its value.
    expect(body.issues.some((issue) => issue.message.includes('"nested"'))).toBe(true);
  });
});

describe('parseQuery', () => {
  const QuerySchema = z.strictObject({
    limit: z.string().regex(/^\d+$/).optional(),
  });

  it('parses query parameters into the schema output', async () => {
    const result = parseQuery(getRequest('?limit=5'), QuerySchema);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the query to parse');
    expect(result.data).toEqual({ limit: '5' });
  });

  it('returns 400 for a duplicate key', async () => {
    const result = parseQuery(getRequest('?limit=1&limit=2'), QuerySchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      error: 'Duplicate query parameter',
    });
  });

  it('returns 400 for a value the schema rejects', async () => {
    const result = parseQuery(getRequest('?limit=abc'), QuerySchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(400);

    const body: {
      error: string;
      issues: Array<{ path: string; message: string }>;
    } = await result.response.json();
    expect(body.error).toBe('Invalid request');
    expect(body.issues[0]?.path).toBe('limit');
  });

  it('returns 400 for an unknown key under a strict schema', async () => {
    const result = parseQuery(getRequest('?page=1'), QuerySchema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.response.status).toBe(400);

    const body: {
      error: string;
      issues: Array<{ path: string; message: string }>;
    } = await result.response.json();
    expect(body.issues[0]?.message).toContain('"page"');
  });
});
