// TARGET PATH: apps/web/src/lib/crypto/secret-box.ts
//
// AES-256-GCM authenticated encryption for secrets we must store but must
// never store readable — right now that's Instagram long-lived access
// tokens in Creator.instagramTokenCiphertext.
//
// Why GCM and not plain AES-CBC: GCM gives us an authentication tag, so a
// row that has been tampered with fails loudly on decrypt instead of
// yielding plausible garbage we'd then send to Meta. The `context`
// argument is bound in as Additional Authenticated Data, which means a
// ciphertext lifted out of one column cannot be replayed into another —
// it will only decrypt under the exact context string it was sealed with.
//
// Node-only by construction (`node:crypto`). Any route that imports this,
// directly or transitively, must run on the nodejs runtime, not edge.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

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

let cachedKey: Buffer | undefined;

function getMasterKey(): Buffer {
  // env.ts already proved this is base64 decoding to exactly 32 bytes.
  cachedKey ??= Buffer.from(env.INSTAGRAM_TOKEN_ENCRYPTION_KEY, 'base64');
  return cachedKey;
}

/**
 * Domain-separated subkey off the master key, so unrelated subsystems never
 * share raw key material. Used by the OAuth state signer — one secret in
 * the environment, distinct keys per purpose.
 */
export function deriveSubkey(info: string): Buffer {
  return createHmac('sha256', getMasterKey()).update(info).digest();
}

/**
 * Returns `v1.<iv>.<tag>.<ciphertext>`, each component base64url so the
 * value is safe in logs, URLs, and Postgres text columns alike.
 */
export function encryptSecret(plaintext: string, context: string): string {
  if (plaintext.length === 0) {
    throw new SecretBoxError('Refusing to encrypt an empty secret');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getMasterKey(), iv, {
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

/**
 * Throws SecretBoxError on any failure — wrong key, wrong context, or a
 * modified row. Never include the caller's ciphertext in the message.
 */
export function decryptSecret(envelope: string, context: string): string {
  const parts = envelope.split('.');

  if (parts.length !== 4) {
    throw new SecretBoxError('Malformed ciphertext envelope');
  }

  const [version, ivB64, tagB64, ciphertextB64] = parts;

  if (version !== FORMAT_VERSION) {
    throw new SecretBoxError(`Unsupported ciphertext version: ${version}`);
  }

  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError('Malformed ciphertext envelope');
  }

  const decipher = createDecipheriv(ALGORITHM, getMasterKey(), iv, {
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
