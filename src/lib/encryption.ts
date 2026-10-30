// Decryption for the `credential` table's value bags.
//
// Each value is stored as three base64 parts, `iv:authTag:ciphertext`, and is
// encrypted with AES-256-GCM under a key derived as sha256(ENCRYPTION_KEY).
// The GCM auth tag means a wrong key fails loudly rather than returning
// plausible-looking garbage.
//
// ENCRYPTION_KEY is read straight from process.env rather than through env.ts:
// env.ts imports this module, so importing back would be a cycle, and the key
// is bootstrap config that could never come from the credential table anyway.
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/** Derived lazily so a missing key surfaces at first use, not at import time. */
function getKey(): Buffer {
  if (!cachedKey) {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) {
      throw new Error('ENCRYPTION_KEY is not set - cannot decrypt credential values');
    }
    cachedKey = crypto.createHash('sha256').update(secret).digest();
  }
  return cachedKey;
}

/** Decrypts a single `iv:authTag:ciphertext` value. Throws if the value is
 *  malformed or the key is wrong (GCM authentication failure). */
export function decryptValue(token: string): string {
  const parts = token.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value - expected iv:authTag:ciphertext');
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Decrypts every entry of a credential's value bag. A value that fails to
 * decrypt is dropped rather than propagated, so one bad entry cannot take down
 * an unrelated lookup - the caller then falls back to process.env.
 */
export function decryptValues(values: Record<string, string>): Record<string, string> {
  const decrypted: Record<string, string> = {};

  for (const [field, value] of Object.entries(values)) {
    try {
      decrypted[field] = decryptValue(value);
    } catch (error) {
      console.error(`Failed to decrypt credential field "${field}":`, error);
    }
  }

  return decrypted;
}
