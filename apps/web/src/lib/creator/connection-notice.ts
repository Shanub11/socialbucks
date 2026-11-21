// apps/web/src/lib/creator/connection-notice.ts
//
// The accounts page renders whatever an OAuth callback put in the query string.
// That value is attacker-controllable (anyone can link to
// /creator/accounts?youtube=error&reason=...), so this module owns the mapping
// and never copies a reason code into visible copy unless it is a code the
// callbacks actually send.

export type ConnectionNotice = {
  tone: 'success' | 'info' | 'error';
  title: string;
  body: string;
  reference?: string;
};

type ProviderKey = 'youtube' | 'instagram';

type Provider = {
  key: ProviderKey;
  label: 'YouTube' | 'Instagram';
  connectedBody: string;
};

const YOUTUBE: Provider = {
  key: 'youtube',
  label: 'YouTube',
  connectedBody: 'Your channel is linked and can be used for supported campaigns.',
};

const INSTAGRAM: Provider = {
  key: 'instagram',
  label: 'Instagram',
  connectedBody:
    'Your account is linked. Instagram campaign settlement is not enabled yet.',
};

/** Every reason code the two callbacks can append. Anything else is ignored. */
const REASON_COPY: Record<string, string> = {
  denied: 'You cancelled the authorization. Nothing was changed.',
  invalid_request:
    'The provider sent us back without an authorization code. Please try again.',
  security_check_failed:
    'That connection attempt could not be verified. It may have expired or been opened in a different browser. Please start again from this page.',
  missing_scope:
    'Some permissions were declined. Please reconnect and leave every requested permission enabled.',
  already_linked:
    'That account is already connected to a different socialbucks account.',
  not_provisioned:
    'Your socialbucks account is still being set up. Wait a moment and try again.',
  youtube_error: 'YouTube rejected the connection. Please try again.',
  instagram_error:
    'Instagram rejected the connection. Confirm your account is a Business or Creator account, then try again.',
  unexpected: 'Something went wrong connecting your account. Please try again.',
};

const GENERIC_ERROR = REASON_COPY.unexpected;

/** Membership by own key only: `reason` comes from a URL, so `toString` is not a code. */
const KNOWN_REASONS = new Set(Object.keys(REASON_COPY));

/**
 * The provider whose callback reported a status.
 *
 * YouTube wins when both are present: the two callbacks are separate requests,
 * and a URL carrying both is not something either callback produces.
 */
function reportedProvider(input: {
  youtube?: string;
  instagram?: string;
}): { provider: Provider; status: string | undefined } | null {
  if (input.youtube !== undefined) {
    return { provider: YOUTUBE, status: input.youtube };
  }

  if (input.instagram !== undefined) {
    return { provider: INSTAGRAM, status: input.instagram };
  }

  return null;
}

/** A `*_error` code only means anything for the provider that sends it. */
function reasonAppliesTo(provider: Provider, reason: string): boolean {
  if (reason === 'youtube_error') {
    return provider.key === 'youtube';
  }

  if (reason === 'instagram_error') {
    return provider.key === 'instagram';
  }

  return true;
}

/**
 * The banner to show for the query string, or `null` when there is nothing to
 * say. Unknown status values return `null` rather than an error banner: a
 * hand-edited URL should not look like a failed connection.
 */
export function connectionNotice(input: {
  youtube?: string;
  instagram?: string;
  reason?: string;
}): ConnectionNotice | null {
  const reported = reportedProvider(input);

  if (reported === null) {
    return null;
  }

  const { provider, status } = reported;

  if (status === 'connected') {
    return {
      tone: 'success',
      title: `${provider.label} connected.`,
      body: provider.connectedBody,
    };
  }

  if (status === 'disconnected') {
    return {
      tone: 'info',
      title: `${provider.label} disconnected.`,
      body: 'The account is no longer connected.',
    };
  }

  if (status !== 'error') {
    return null;
  }

  const reason = input.reason;

  // The code is known and applies here, so the banner explains it and carries
  // the code for support. Unknown values never reach the notice at all.
  if (reason !== undefined && KNOWN_REASONS.has(reason) && reasonAppliesTo(provider, reason)) {
    return {
      tone: 'error',
      title: 'Could not connect.',
      body: REASON_COPY[reason],
      reference: reason,
    };
  }

  // Unknown code, no code, or the other provider's `*_error`: generic copy. A
  // known-but-mismatched code is still ours, so it stays as the reference.
  const isKnownCode = reason !== undefined && KNOWN_REASONS.has(reason);

  return {
    tone: 'error',
    title: 'Could not connect.',
    body: GENERIC_ERROR,
    ...(isKnownCode ? { reference: reason } : {}),
  };
}
