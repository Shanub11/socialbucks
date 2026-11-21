// apps/web/src/lib/creator/connection-notice.test.ts
//
// Pure unit tests for the OAuth callback banner. The input arrives in a URL, so
// the tests pin the two security-relevant rules: unknown reason values never
// reach the page, and a provider's `*_error` code cannot be borrowed by the
// other provider's banner copy.

import { describe, expect, it } from 'vitest';

import { connectionNotice } from './connection-notice';

const GENERIC_ERROR = 'Something went wrong connecting your account. Please try again.';

/** Every reason code either callback sends, with the provider that sends it. */
const REASONS: { reason: string; provider: 'youtube' | 'instagram'; body: string }[] = [
  {
    reason: 'denied',
    provider: 'youtube',
    body: 'You cancelled the authorization. Nothing was changed.',
  },
  {
    reason: 'invalid_request',
    provider: 'instagram',
    body: 'The provider sent us back without an authorization code. Please try again.',
  },
  {
    reason: 'security_check_failed',
    provider: 'youtube',
    body: 'That connection attempt could not be verified. It may have expired or been opened in a different browser. Please start again from this page.',
  },
  {
    reason: 'missing_scope',
    provider: 'instagram',
    body: 'Some permissions were declined. Please reconnect and leave every requested permission enabled.',
  },
  {
    reason: 'already_linked',
    provider: 'youtube',
    body: 'That account is already connected to a different socialbucks account.',
  },
  {
    reason: 'not_provisioned',
    provider: 'instagram',
    body: 'Your socialbucks account is still being set up. Wait a moment and try again.',
  },
  {
    reason: 'youtube_error',
    provider: 'youtube',
    body: 'YouTube rejected the connection. Please try again.',
  },
  {
    reason: 'instagram_error',
    provider: 'instagram',
    body: 'Instagram rejected the connection. Confirm your account is a Business or Creator account, then try again.',
  },
  { reason: 'unexpected', provider: 'youtube', body: GENERIC_ERROR },
];

describe('connectionNotice', () => {
  it('says nothing when no provider reported a status', () => {
    expect(connectionNotice({})).toBeNull();
    expect(connectionNotice({ reason: 'denied' })).toBeNull();
  });

  it('says nothing for a status value neither callback sends', () => {
    expect(connectionNotice({ youtube: 'pending' })).toBeNull();
    expect(connectionNotice({ instagram: 'CONNECTED' })).toBeNull();
    expect(connectionNotice({ youtube: '', instagram: '' })).toBeNull();
  });

  it('describes a YouTube connection as usable for campaigns', () => {
    expect(connectionNotice({ youtube: 'connected' })).toStrictEqual({
      tone: 'success',
      title: 'YouTube connected.',
      body: 'Your channel is linked and can be used for supported campaigns.',
    });
  });

  it('describes an Instagram connection without promising settlement', () => {
    expect(connectionNotice({ instagram: 'connected' })).toStrictEqual({
      tone: 'success',
      title: 'Instagram connected.',
      body: 'Your account is linked. Instagram campaign settlement is not enabled yet.',
    });
  });

  it('describes a disconnection as information, not an error', () => {
    expect(connectionNotice({ youtube: 'disconnected' })).toStrictEqual({
      tone: 'info',
      title: 'YouTube disconnected.',
      body: 'The account is no longer connected.',
    });
    expect(connectionNotice({ instagram: 'disconnected' })).toStrictEqual({
      tone: 'info',
      title: 'Instagram disconnected.',
      body: 'The account is no longer connected.',
    });
  });

  it('explains every known reason code and carries it as the reference', () => {
    for (const entry of REASONS) {
      const notice = connectionNotice(
        entry.provider === 'youtube'
          ? { youtube: 'error', reason: entry.reason }
          : { instagram: 'error', reason: entry.reason },
      );

      expect(notice).toStrictEqual({
        tone: 'error',
        title: 'Could not connect.',
        body: entry.body,
        reference: entry.reason,
      });
    }
  });

  it('uses generic copy when a *_error code belongs to the other provider', () => {
    expect(connectionNotice({ youtube: 'error', reason: 'instagram_error' })).toStrictEqual({
      tone: 'error',
      title: 'Could not connect.',
      body: GENERIC_ERROR,
      reference: 'instagram_error',
    });

    expect(connectionNotice({ instagram: 'error', reason: 'youtube_error' })).toStrictEqual({
      tone: 'error',
      title: 'Could not connect.',
      body: GENERIC_ERROR,
      reference: 'youtube_error',
    });
  });

  it('never echoes an unknown reason value', () => {
    const notice = connectionNotice({ youtube: 'error', reason: '<script>x</script>' });

    expect(notice).toStrictEqual({
      tone: 'error',
      title: 'Could not connect.',
      body: GENERIC_ERROR,
    });
    expect(notice).not.toHaveProperty('reference');
  });

  it('does not treat an inherited property name as a reason code', () => {
    const notice = connectionNotice({ youtube: 'error', reason: 'toString' });

    expect(notice).toStrictEqual({
      tone: 'error',
      title: 'Could not connect.',
      body: GENERIC_ERROR,
    });
    expect(notice).not.toHaveProperty('reference');
  });

  it('shows the generic error when the callback sent no reason', () => {
    const notice = connectionNotice({ instagram: 'error' });

    expect(notice).toStrictEqual({
      tone: 'error',
      title: 'Could not connect.',
      body: GENERIC_ERROR,
    });
    expect(notice).not.toHaveProperty('reference');
  });

  it('gives YouTube precedence when both providers are in the query string', () => {
    const notice = connectionNotice({
      youtube: 'connected',
      instagram: 'error',
      reason: 'denied',
    });

    expect(notice).toStrictEqual({
      tone: 'success',
      title: 'YouTube connected.',
      body: 'Your channel is linked and can be used for supported campaigns.',
    });
  });
});
