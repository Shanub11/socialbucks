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
 * Internal fetch helper shared by requestJson and requestJsonWithHeaders.
 * Handles timeout, no-store cache, JSON parsing, and network errors.
 */
async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
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
  return { response, body };
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
  const { response, body } = await fetchJson(url, init);
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
 * Like requestJson but returns the response headers alongside the body.
 * Needed to honor Retry-After headers on rate-limited responses.
 */
export async function requestJsonWithHeaders(
  url: string,
  init: RequestInit = {},
): Promise<{ body: unknown; headers: Headers; status: number }> {
  const { response, body } = await fetchJson(url, init);
  return { body, headers: response.headers, status: response.status };
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

/**
 * Exponential backoff with jitter for rate limits and transient errors.
 * Honors the provider's Retry-After header when present.
 *
 * @param attempt - Zero-based attempt number (0 = first retry)
 * @param retryAfterMs - Optional Retry-After value in milliseconds
 * @returns Number of milliseconds to wait before the next attempt
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs && retryAfterMs > 0) {
    return retryAfterMs;
  }
  const baseDelayMs = 500;
  const exponential = baseDelayMs * (2 ** attempt);
  // Jitter: random value between 0 and exponential delay
  const jitter = Math.floor(Math.random() * exponential);
  return exponential + jitter;
}

/**
 * Sleep for the given number of milliseconds.
 * Exported so callers (and tests) can stub the delay.
 */
export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}