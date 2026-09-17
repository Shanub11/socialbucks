// apps/web/src/lib/crypto/secret-box.ts
//
// AES-256-GCM authenticated encryption for OAuth tokens that must be stored
// but must never be stored readable.
//
// Why GCM and not plain AES-CBC: GCM produces an authentication tag, so a
// tampered row fails loudly on decrypt instead of yielding plausible garbage
// we'd then send to Meta or Google. The `context` argument is bound in as
// Additional Authenticated Data (AAD), which means a ciphertext lifted from
// one column or one platform cannot be replayed into another — it only
// decrypts under the exact context string it was sealed with.
//
// Platform-scoped keys: Instagram and YouTube each have their own AES-256
// key (INSTAGRAM_TOKEN_ENCRYPTION_KEY / YOUTUBE_TOKEN_ENCRYPTION_KEY).
// A ciphertext leak on one platform does not compromise the other.
//
// Node-only by construction (`node:crypto`). Any route that imports this,
// directly or transitively, must declare `export const runtime = 'nodejs'`.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

import { SocialPlatform } from '@repo/database';

import { env } from '@/lib/env';

const ALGORITHM = 'aes-256-gcm';
/** 96-bit nonce: the size GCM is specified for, and the only one that skips
 *  the extra internal derivation step other lengths trigger. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bump this if the envelope layout changes, so old rows stay decryptable. */
const FORMAT_VERSION = 'v1';

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

// One cached Buffer per platform — decoded once on first use, then reused.
const keyCache = new Map<SocialPlatform, Buffer>();

/**
 * Returns the AES-256 key for the given platform.
 *
 * Each platform has an independent key so that rotating (or leaking) one
 * does not affect the other. env.ts validates that both are well-formed
 * base64 strings decoding to exactly 32 bytes at boot time.
 */
function getPlatformKey(platform: SocialPlatform): Buffer {
  const cached = keyCache.get(platform);
  if (cached) return cached;

  const raw =
    platform === SocialPlatform.INSTAGRAM
      ? env.INSTAGRAM_TOKEN_ENCRYPTION_KEY
      : env.YOUTUBE_TOKEN_ENCRYPTION_KEY;

  const key = Buffer.from(raw, 'base64');
  keyCache.set(platform, key);
  return key;
}

// Backward-compatible shim used by deriveSubkey and the existing
// encryptSecret/decryptSecret low-level API (both callers still pass
// TOKEN_ENCRYPTION_CONTEXT from instagram/constants.ts until Step 4
// migrates them to encryptToken/decryptToken).
let cachedInstagramKey: Buffer | undefined;
function getMasterKey(): Buffer {
  cachedInstagramKey ??= getPlatformKey(SocialPlatform.INSTAGRAM);
  return cachedInstagramKey;
}

/**
 * Domain-separated subkey off the Instagram master key, so unrelated
 * subsystems never share raw key material. Used by the OAuth state signer —
 * one secret in the environment, distinct keys per purpose.
 *
 * YouTube OAuth state can derive its own subkey from the YouTube key using
 * the same pattern; the signer just needs to be initialised with the right
 * base key.
 */
export function deriveSubkey(info: string): Buffer {
  return createHmac('sha256', getMasterKey()).update(info).digest();
}

// ---------------------------------------------------------------------------
// AAD context strings — one per (platform, token kind) pair.
//
// Changing any of these strings makes every existing row undecryptable, so
// treat them as part of the storage format alongside FORMAT_VERSION.
// ---------------------------------------------------------------------------

/**
 * The canonical AAD context string for a given platform and token kind.
 *
 * • Instagram: 60-day long-lived access token.
 * • YouTube:   OAuth2 refresh token (offline_access, no fixed expiry).
 *
 * The context encodes the platform, semantic role, and format version so
 * that a ciphertext produced for one purpose cannot be replayed into another.
 */
export const TOKEN_CONTEXTS: Record<SocialPlatform, string> = {
  [SocialPlatform.INSTAGRAM]: 'instagram:long_lived_access_token:v1',
  [SocialPlatform.YOUTUBE]:   'youtube:refresh_token:v1',
};

// ---------------------------------------------------------------------------
// Low-level API (kept for backward compatibility — existing callers pass an
// explicit context string and this does not change until Step 4 migrates them)
// ---------------------------------------------------------------------------

function rawEncrypt(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(context, 'utf8'));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function rawDecrypt(key: Buffer, envelope: string, context: string): string {
  const parts = envelope.split('.');

  if (parts.length !== 4) {
    throw new SecretBoxError('Malformed ciphertext envelope');
  }

  const [version, ivB64, tagB64, ciphertextB64] = parts;

  if (version !== FORMAT_VERSION) {
    throw new SecretBoxError(`Unsupported ciphertext version: ${version}`);
  }

  const iv  = Buffer.from(ivB64,  'base64url');
  const tag = Buffer.from(tagB64, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError('Malformed ciphertext envelope');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // decipher.final() throws when the tag doesn't verify. Deliberately
    // opaque: the caller gets "this didn't decrypt", not which check failed.
    throw new SecretBoxError(
      'Decryption failed — wrong key, wrong context, or tampered ciphertext',
    );
  }
}

/**
 * Returns `v1.<iv>.<tag>.<ciphertext>`, each component base64url so the
 * value is safe in logs, URLs, and Postgres text columns alike.
 *
 * This low-level form requires the caller to supply the AAD context string
 * explicitly. Prefer {@link encryptToken} for `SocialAccount.tokenCiphertext`
 * writes — it derives the correct context from the platform automatically.
 */
export function encryptSecret(plaintext: string, context: string): string {
  if (plaintext.length === 0) {
    throw new SecretBoxError('Refusing to encrypt an empty secret');
  }
  return rawEncrypt(getMasterKey(), plaintext, context);
}

/**
 * Throws SecretBoxError on any failure — wrong key, wrong context, or a
 * tampered row. Never includes the caller's ciphertext in the message.
 */
export function decryptSecret(envelope: string, context: string): string {
  return rawDecrypt(getMasterKey(), envelope, context);
}

// ---------------------------------------------------------------------------
// Platform-aware API — use these for all SocialAccount.tokenCiphertext writes
// ---------------------------------------------------------------------------

/**
 * Encrypts an OAuth token for the given platform.
 *
 * Automatically selects the correct AES-256 key and AAD context for the
 * platform, so callers never need to construct or import context strings.
 *
 * ```ts
 * // Instagram long-lived access token
 * const ciphertext = encryptToken(accessToken, SocialPlatform.INSTAGRAM);
 *
 * // YouTube refresh token
 * const ciphertext = encryptToken(refreshToken, SocialPlatform.YOUTUBE);
 * ```
 *
 * Throws {@link SecretBoxError} if `plaintext` is empty.
 */
export function encryptToken(plaintext: string, platform: SocialPlatform): string {
  if (plaintext.length === 0) {
    throw new SecretBoxError('Refusing to encrypt an empty token');
  }
  return rawEncrypt(getPlatformKey(platform), plaintext, TOKEN_CONTEXTS[platform]);
}

/**
 * Decrypts a `SocialAccount.tokenCiphertext` envelope for the given platform.
 *
 * The platform must match the one used at encrypt time: an Instagram
 * ciphertext cannot be decrypted under `SocialPlatform.YOUTUBE` and vice
 * versa — both the key and the AAD context differ.
 *
 * Throws {@link SecretBoxError} on any failure — wrong platform, wrong key,
 * tampered row, or malformed envelope. The error message is intentionally
 * opaque; detail goes to the server log, not the response.
 */
export function decryptToken(envelope: string, platform: SocialPlatform): string {
  return rawDecrypt(getPlatformKey(platform), envelope, TOKEN_CONTEXTS[platform]);
}

