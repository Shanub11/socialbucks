// apps/web/src/lib/oauth/request.ts
//
// Shared HTTP hardening for every external OAuth provider we talk to.
//
// Every function here handles a *secret*, so the rules are the same for
// Instagram and YouTube:
//
//   - nothing logs a token, a code, or an app secret;
//   - every response is parsed through zod rather than trusted, because
//     these are untrusted external payloads and providers change field
//     types between versions;
//   - every request has an explicit timeout, so a hung endpoint can't
//     pin a route handler open indefinitely;
//   - non-2xx responses are turned into a typed error carrying only the
//     provider's own error code, never a message that echoes request
//     parameters back.
//
// Node-only by construction (AbortSignal.timeout, node:crypto callers).

import { z } from 'zod';

/** Per-request timeout. Meta and Google both hang sometimes. */
export const REQUEST_TIMEOUT_MS = 10_000;

export class OAuthHttpError extends Error {
  readonly status: number | undefined;
  /** Provider's own error code, when one was sent. Safe to log. */
  readonly providerCode: string | undefined;

  constructor(
    message: string,
    options: { status?: number; providerCode?: string } = {},
  ) {
    super(message);
    this.name = 'OAuthHttpError';
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OAuthHttpError('Provider returned a non-JSON response', {
      status: response.status,
    });
  }
}

/**
 * Turns a non-2xx into an OAuthHttpError carrying only the provider's own
 * error code and type. Provider `message` fields can echo request parameters
 * back, so they are deliberately not propagated into the thrown message.
 */
export function throwForStatus(
  response: Response,
  body: unknown,
  errorSchema: z.ZodTypeAny,
  label: string,
): never {
  const parsed = errorSchema.safeParse(body);
  const code = parsed.success
    ? String(
        (parsed.data as { error?: { code?: unknown } })?.error?.code ??
          (parsed.data as { error_type?: unknown })?.error_type ??
          'unknown',
      )
    : 'unparseable';

  throw new OAuthHttpError(`${label} rejected the request (code ${code})`, {
    status: response.status,
    providerCode: code,
  });
}

/**
 * Exported so each provider's lib can reuse the same hardening instead of
 * re-implementing it. Treat as internal to lib/oauth — routes should not
 * call it directly.
 */
export async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    throw new OAuthHttpError(
      timedOut
        ? 'Provider request timed out'
        : 'Provider request failed to connect',
    );
  }

  const body = await readJson(response);
  if (!response.ok) {
    // `throwForStatus` is provided by each provider module, which knows how
    // to extract a safe code from that provider's error envelope.
    throw new OAuthHttpError(
      `Provider returned ${response.status}`,
      { status: response.status },
    );
  }
  return body;
}

/**
 * Parse an untrusted provider payload through zod, logging only the *shape*
 * of the failure — never the body, which may contain a live token.
 */
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  body: unknown,
  label: string,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    console.error(`[oauth] unexpected ${label} response shape`, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
    throw new OAuthHttpError(`Unexpected ${label} response from provider`);
  }
  return result.data;
}