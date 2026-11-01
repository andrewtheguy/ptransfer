import { t } from '../i18n';
import { AES_NONCE_LENGTH, AES_TAG_LENGTH } from './constants';

/**
 * Streaming encryption/decryption utilities for P2P transfers.
 *
 * Each chunk is encrypted separately with its own nonce, allowing:
 * - Sender to encrypt on-the-fly as chunks are sent
 * - Receiver to decrypt on-the-fly as chunks arrive
 * - Memory-efficient transfer (no need to buffer entire file encrypted)
 *
 * Encrypted chunk format:
 *   [2-byte chunk index (big-endian)][12-byte nonce][ciphertext][16-byte tag]
 *
 * The chunk index is also passed as AES-GCM additional authenticated data.
 * That keeps the wire format compact while making the write position tamper-evident.
 *
 * Total overhead per chunk: 2 + 12 + 16 = 30 bytes
 */

// Chunk index is 2 bytes (big-endian), supporting up to 65535 chunks.
const CHUNK_INDEX_SIZE = 2;
const OVERHEAD_PER_CHUNK = CHUNK_INDEX_SIZE + AES_NONCE_LENGTH + AES_TAG_LENGTH;

function encodeChunkIndex(chunkIndex: number): Uint8Array {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffff) {
    throw new Error(`Chunk index out of range: ${chunkIndex}`);
  }

  return new Uint8Array([(chunkIndex >> 8) & 0xff, chunkIndex & 0xff]);
}

/**
 * Encrypt a single chunk with chunk index prefix.
 *
 * @param key - AES-GCM encryption key
 * @param plaintext - Raw chunk data to encrypt
 * @param chunkIndex - 0-based chunk index (0-65535)
 * @returns Encrypted chunk with format: [2-byte index][nonce][ciphertext][tag]
 */
export async function encryptChunk(
  key: CryptoKey,
  plaintext: Uint8Array,
  chunkIndex: number,
): Promise<Uint8Array> {
  // Laid out in place: the index and nonce are written where they travel,
  // and only the ciphertext is copied in after.
  const result = new Uint8Array(OVERHEAD_PER_CHUNK + plaintext.length);
  const chunkIndexBytes = result.subarray(0, CHUNK_INDEX_SIZE);
  chunkIndexBytes.set(encodeChunkIndex(chunkIndex));
  const nonce = result.subarray(
    CHUNK_INDEX_SIZE,
    CHUNK_INDEX_SIZE + AES_NONCE_LENGTH,
  );
  crypto.getRandomValues(nonce);

  // Web Crypto copies its inputs when called, so neither the views into
  // `result` nor a caller's reused `plaintext` buffer can change under it.
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      additionalData: chunkIndexBytes as BufferSource,
    },
    key,
    plaintext as BufferSource,
  );

  // Ciphertext with the tag Web Crypto appends.
  result.set(new Uint8Array(ciphertext), CHUNK_INDEX_SIZE + AES_NONCE_LENGTH);
  return result;
}

/**
 * Parse an encrypted chunk message to extract chunk index and encrypted data.
 *
 * @param data - Raw message data (ArrayBuffer or Uint8Array)
 * @returns Parsed chunk with index and encrypted payload; the payload is a
 *   view onto `data`, not a copy, so `data` must not change while it is used
 */
export function parseChunkMessage(data: ArrayBuffer | Uint8Array): {
  chunkIndex: number;
  encryptedData: Uint8Array;
} {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (bytes.length < OVERHEAD_PER_CHUNK) {
    throw new Error(
      t({
        en: `Message too short: ${bytes.length} bytes, need at least ${OVERHEAD_PER_CHUNK}`,
        es: `Mensaje demasiado corto: ${bytes.length} bytes, se necesitan al menos ${OVERHEAD_PER_CHUNK}`,
      }),
    );
  }

  // Read chunk index (big-endian 16-bit)
  const chunkIndex = (bytes[0] << 8) | bytes[1];

  // Rest is the encrypted data (nonce + ciphertext + tag)
  const encryptedData = bytes.subarray(CHUNK_INDEX_SIZE);

  return { chunkIndex, encryptedData };
}

/**
 * Decrypt an encrypted chunk (after parsing with parseChunkMessage).
 *
 * @param key - AES-GCM decryption key
 * @param encryptedData - Encrypted data (nonce + ciphertext + tag)
 * @returns Decrypted plaintext
 */
export async function decryptChunk(
  key: CryptoKey,
  encryptedData: Uint8Array,
  chunkIndex: number,
): Promise<Uint8Array> {
  if (encryptedData.length < AES_NONCE_LENGTH + AES_TAG_LENGTH) {
    throw new Error(
      t({
        en: `Encrypted data too short: ${encryptedData.length} bytes`,
        es: `Datos cifrados demasiado cortos: ${encryptedData.length} bytes`,
      }),
    );
  }

  const chunkIndexBytes = encodeChunkIndex(chunkIndex);
  // Views, not copies: Web Crypto copies its inputs itself.
  const nonce = encryptedData.subarray(0, AES_NONCE_LENGTH);
  const ciphertext = encryptedData.subarray(AES_NONCE_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      additionalData: chunkIndexBytes as BufferSource,
    },
    key,
    ciphertext as BufferSource,
  );

  return new Uint8Array(plaintext);
}

/**
 * Calculate the overhead added by encryption for a given number of chunks.
 * Useful for progress calculations.
 *
 * @param numChunks - Number of chunks
 * @returns Total overhead in bytes
 */
export function calculateEncryptionOverhead(numChunks: number): number {
  return numChunks * OVERHEAD_PER_CHUNK;
}

/**
 * Encrypted chunk overhead constant (for external use).
 */
export const ENCRYPTED_CHUNK_OVERHEAD = OVERHEAD_PER_CHUNK;
