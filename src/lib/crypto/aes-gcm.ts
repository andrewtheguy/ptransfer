import { AES_NONCE_LENGTH, AES_TAG_LENGTH } from './constants';

// Minimum encrypted data length: nonce + tag (ciphertext can be empty for empty plaintext)
const MIN_ENCRYPTED_LENGTH = AES_NONCE_LENGTH + AES_TAG_LENGTH;

/**
 * Generate random nonce for AES-GCM
 * Each encryption MUST use a unique nonce with the same key
 */
export function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(AES_NONCE_LENGTH);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Encrypt data with AES-256-GCM
 * Returns: nonce (12 bytes) || ciphertext || tag (16 bytes)
 *
 * When `aad` is provided it is bound into the authentication tag; decryption
 * then requires the identical additional data.
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  nonce?: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const iv = nonce ?? generateNonce();

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource,
      ...(aad ? { additionalData: aad as BufferSource } : {}),
    },
    key,
    plaintext as BufferSource,
  );

  // Combine nonce + ciphertext (tag is appended automatically by Web Crypto)
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);

  return result;
}

/**
 * Decrypt data with AES-256-GCM
 * Input: nonce (12 bytes) || ciphertext || tag (16 bytes)
 */
export async function decrypt(
  key: CryptoKey,
  encrypted: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (encrypted.length < MIN_ENCRYPTED_LENGTH) {
    throw new Error(
      `Encrypted data too short: expected at least ${MIN_ENCRYPTED_LENGTH} bytes (nonce + tag)`,
    );
  }

  const nonce = encrypted.slice(0, AES_NONCE_LENGTH);
  const ciphertext = encrypted.slice(AES_NONCE_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      ...(aad ? { additionalData: aad as BufferSource } : {}),
    },
    key,
    ciphertext as BufferSource,
  );

  return new Uint8Array(plaintext);
}

/**
 * Encrypt a string message
 */
export function encryptMessage(
  key: CryptoKey,
  message: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(message);
  return encrypt(key, plaintext);
}

/**
 * Decrypt to a string message
 */
export async function decryptMessage(
  key: CryptoKey,
  encrypted: Uint8Array,
): Promise<string> {
  const plaintext = await decrypt(key, encrypted);
  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}
