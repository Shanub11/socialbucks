// apps/web/src/lib/oauth/connect-start-failure.ts
//
// Fail-closed response for a connect start route whose OAuth configuration is
// broken. The failure path must not touch the environment: a malformed
// REDIRECT_URI or a missing client secret is exactly what can throw here, so
// anything that reads env (including the normal getAppOrigin helper) could
// throw again and turn a handled configuration error into a raw 500.
//
// The Location is therefore relative. The browser resolves it against the
// origin it is already on, which is the only origin guaranteed to exist when
// the configured one is invalid. NextResponse.redirect rejects relative
// URLs, so this uses a plain Response.
//
// The query carries only a coarse, non-leaky reason. Provider messages,
// environment values and config text never appear in the response.

export type ConnectPlatform = 'youtube' | 'instagram';

/**
 * A single leading slash, no protocol-relative form, no whitespace and no
 * backslash. Anything else falls back to the site root, so a caller cannot
 * turn this redirect into an open redirect.
 */
const SAFE_RETURN_PATH = /^\/(?!\/)[^\s\\]*$/;

export function connectStartFailureResponse(args: {
  platform: ConnectPlatform;
  returnPath: string;
}): Response {
  const safePath = SAFE_RETURN_PATH.test(args.returnPath) ? args.returnPath : '/';

  const query = new URLSearchParams({
    [args.platform]: 'error',
    reason: 'unexpected',
  });

  return new Response(null, {
    status: 303,
    headers: {
      Location: `${safePath}?${query.toString()}`,
      'Cache-Control': 'no-store',
    },
  });
}
