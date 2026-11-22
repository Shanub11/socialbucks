// apps/web/src/lib/youtube/disconnect-revoke.test.ts
//
// Unit tests for disconnectYouTubeForUser's revoke-then-clear ordering. The
// social layer, revoke helper and decrypt are mocked; no database or network
// is involved. Every case checks that no token material reaches any console
// method.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/social/creator-link', () => ({
  findActiveTokenCiphertexts: vi.fn(),
  linkSocialAccount: vi.fn(),
  unlinkSocialAccount: vi.fn(),
  disconnectSocialPlatformForUser: vi.fn(),
  purgeSocialData: vi.fn(),
}));

vi.mock('@/lib/youtube/revoke-token', () => ({
  revokeGoogleToken: vi.fn(),
}));

vi.mock('@/lib/crypto/secret-box', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crypto/secret-box')>();
  return { ...actual, decryptToken: vi.fn() };
});

import { SocialPlatform } from '@repo/database';

import { SecretBoxError, decryptToken } from '@/lib/crypto/secret-box';
import {
  disconnectSocialPlatformForUser,
  findActiveTokenCiphertexts,
} from '@/lib/social/creator-link';
import { revokeGoogleToken } from '@/lib/youtube/revoke-token';
import { disconnectYouTubeForUser } from './creator-link';

const CLERK_USER_ID = 'user_test_123';
const CIPHERTEXT = 'v1.test.ciphertext.one';
const CIPHERTEXT_TWO = 'v1.test.ciphertext.two';
const PLAINTEXT_TOKEN = 'test-refresh-token-value';
const PLAINTEXT_TOKEN_TWO = 'test-refresh-token-value-two';
const SENTINEL = 'SENTINEL_SECRET';

const consoleSpies = (['error', 'warn', 'info', 'log'] as const).map((method) =>
  vi.spyOn(console, method).mockImplementation(() => undefined),
);
const consoleInfo = consoleSpies[2];

const NEVER_LOGGED = [
  CIPHERTEXT,
  CIPHERTEXT_TWO,
  PLAINTEXT_TOKEN,
  PLAINTEXT_TOKEN_TWO,
  SENTINEL,
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findActiveTokenCiphertexts)
    .mockReset()
    .mockResolvedValue([]);
  vi.mocked(decryptToken).mockReset();
  vi.mocked(revokeGoogleToken).mockReset();
  vi.mocked(disconnectSocialPlatformForUser)
    .mockReset()
    .mockResolvedValue('disconnected');
});

afterEach(() => {
  const logged = JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));
  for (const forbidden of NEVER_LOGGED) {
    expect(logged).not.toContain(forbidden);
  }
});

describe('disconnectYouTubeForUser', () => {
  it('no active token: skips decrypt and revoke, disconnects, logs nothing', async () => {
    const result = await disconnectYouTubeForUser(CLERK_USER_ID);

    expect(result).toBe('disconnected');
    expect(decryptToken).not.toHaveBeenCalled();
    expect(revokeGoogleToken).not.toHaveBeenCalled();
    expect(disconnectSocialPlatformForUser).toHaveBeenCalledTimes(1);
    expect(disconnectSocialPlatformForUser).toHaveBeenCalledWith(
      CLERK_USER_ID,
      SocialPlatform.YOUTUBE,
    );
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('one token revoked: decrypts, revokes before disconnecting, logs counts', async () => {
    vi.mocked(findActiveTokenCiphertexts).mockResolvedValue([CIPHERTEXT]);
    vi.mocked(decryptToken).mockReturnValue(PLAINTEXT_TOKEN);
    vi.mocked(revokeGoogleToken).mockResolvedValue('revoked');

    const result = await disconnectYouTubeForUser(CLERK_USER_ID);

    expect(result).toBe('disconnected');
    expect(decryptToken).toHaveBeenCalledWith(
      CIPHERTEXT,
      SocialPlatform.YOUTUBE,
    );
    expect(revokeGoogleToken).toHaveBeenCalledWith(PLAINTEXT_TOKEN);

    const revokeOrder =
      vi.mocked(revokeGoogleToken).mock.invocationCallOrder[0];
    const disconnectOrder =
      vi.mocked(disconnectSocialPlatformForUser).mock
        .invocationCallOrder[0];
    expect(revokeOrder).toBeLessThan(disconnectOrder);

    expect(consoleInfo).toHaveBeenCalledWith(
      '[youtube] token revoke attempted',
      { revoked: 1, rejected: 0, unavailable: 0, failed: 0, undecryptable: 0 },
    );
  });

  it.each([
    ['rejected', 0, 1, 0, 0],
    ['unavailable', 0, 0, 1, 0],
    ['failed', 0, 0, 0, 1],
  ] as const)(
    'revoke %s: still disconnects and logs the outcome',
    async (outcome, revoked, rejected, unavailable, failed) => {
      vi.mocked(findActiveTokenCiphertexts).mockResolvedValue([CIPHERTEXT]);
      vi.mocked(decryptToken).mockReturnValue(PLAINTEXT_TOKEN);
      vi.mocked(revokeGoogleToken).mockResolvedValue(outcome);

      const result = await disconnectYouTubeForUser(CLERK_USER_ID);

      expect(result).toBe('disconnected');
      expect(disconnectSocialPlatformForUser).toHaveBeenCalledTimes(1);
      expect(consoleInfo).toHaveBeenCalledWith(
        '[youtube] token revoke attempted',
        {
          revoked,
          rejected,
          unavailable,
          failed,
          undecryptable: 0,
        },
      );
    },
  );

  it('decrypt failure: no revoke, still disconnects, counts undecryptable', async () => {
    vi.mocked(findActiveTokenCiphertexts).mockResolvedValue([CIPHERTEXT]);
    vi.mocked(decryptToken).mockImplementation(() => {
      throw new SecretBoxError(`cannot decrypt: ${SENTINEL}`);
    });

    const result = await disconnectYouTubeForUser(CLERK_USER_ID);

    expect(result).toBe('disconnected');
    expect(revokeGoogleToken).not.toHaveBeenCalled();
    expect(disconnectSocialPlatformForUser).toHaveBeenCalledTimes(1);
    expect(consoleInfo).toHaveBeenCalledWith(
      '[youtube] token revoke attempted',
      { revoked: 0, rejected: 0, unavailable: 0, failed: 0, undecryptable: 1 },
    );
  });

  it('revoke helper rejecting: still disconnects and counts failed', async () => {
    vi.mocked(findActiveTokenCiphertexts).mockResolvedValue([CIPHERTEXT]);
    vi.mocked(decryptToken).mockReturnValue(PLAINTEXT_TOKEN);
    vi.mocked(revokeGoogleToken).mockRejectedValue(
      new Error('defensive revoke failure'),
    );

    const result = await disconnectYouTubeForUser(CLERK_USER_ID);

    expect(result).toBe('disconnected');
    expect(disconnectSocialPlatformForUser).toHaveBeenCalledTimes(1);
    expect(consoleInfo).toHaveBeenCalledWith(
      '[youtube] token revoke attempted',
      { revoked: 0, rejected: 0, unavailable: 0, failed: 1, undecryptable: 0 },
    );
  });

  it('ciphertext lookup failure: rejects before any revoke or disconnect', async () => {
    vi.mocked(findActiveTokenCiphertexts).mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(disconnectYouTubeForUser(CLERK_USER_ID)).rejects.toBeInstanceOf(
      Error,
    );

    expect(decryptToken).not.toHaveBeenCalled();
    expect(revokeGoogleToken).not.toHaveBeenCalled();
    expect(disconnectSocialPlatformForUser).not.toHaveBeenCalled();
  });

  it('two ciphertexts: processes in order and sums the counts', async () => {
    vi.mocked(findActiveTokenCiphertexts).mockResolvedValue([
      CIPHERTEXT,
      CIPHERTEXT_TWO,
    ]);
    vi.mocked(decryptToken).mockImplementation((value: string) =>
      value === CIPHERTEXT ? PLAINTEXT_TOKEN : PLAINTEXT_TOKEN_TWO,
    );
    vi.mocked(revokeGoogleToken)
      .mockResolvedValueOnce('revoked')
      .mockResolvedValueOnce('rejected');

    const result = await disconnectYouTubeForUser(CLERK_USER_ID);

    expect(result).toBe('disconnected');
    expect(revokeGoogleToken).toHaveBeenNthCalledWith(1, PLAINTEXT_TOKEN);
    expect(revokeGoogleToken).toHaveBeenNthCalledWith(2, PLAINTEXT_TOKEN_TWO);
    expect(consoleInfo).toHaveBeenCalledWith(
      '[youtube] token revoke attempted',
      { revoked: 1, rejected: 1, unavailable: 0, failed: 0, undecryptable: 0 },
    );
  });
});
