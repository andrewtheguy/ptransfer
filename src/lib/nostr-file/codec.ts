import { deflateSync, inflateSync } from 'fflate';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { NOSTR_FILE_AAD_PREFIX, NOSTR_FILE_CHUNK_SIZE } from './constants';
import { decodeZ85, encodeZ85 } from './z85';

/**
 * Split plaintext into fixed-size chunks (last chunk may be shorter).
 */
export function splitIntoChunks(
  data: Uint8Array,
  chunkSize: number,
): Uint8Array[] {
  if (chunkSize <= 0) throw new Error('chunkSize must be positive');
  if (data.length === 0) throw new Error('cannot chunk empty data');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(
      data.subarray(offset, Math.min(offset + chunkSize, data.length)),
    );
  }
  return chunks;
}

/**
 * Additional authenticated data binding a chunk to its transfer, index, and
 * total count — blocks cross-index and cross-transfer chunk substitution even
 * if event tags were spoofed.
 */
export function chunkAad(
  transferId: string,
  index: number,
  total: number,
): Uint8Array {
  return new TextEncoder().encode(
    `${NOSTR_FILE_AAD_PREFIX}:${transferId}:${index}:${total}`,
  );
}

/**
 * Chunk plaintext -> nostr event content string.
 * Pipeline: deflate -> AES-256-GCM (nonce||ct||tag, AAD-bound) -> Z85
 * (base85, like nostrsave: smaller than base64 and JSON-escape-free).
 */
export async function encodeChunkContent(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const compressed = deflateSync(plaintext);
  const encrypted = await encrypt(key, compressed, undefined, aad);
  return encodeZ85(encrypted);
}

/**
 * Nostr event content string -> chunk plaintext.
 * Throws on tampering (GCM auth failure), wrong AAD, corrupt deflate data,
 * or a decompressed size above maxSize (decompression-bomb guard).
 */
export async function decodeChunkContent(
  key: CryptoKey,
  content: string,
  aad: Uint8Array,
  maxSize: number = NOSTR_FILE_CHUNK_SIZE,
): Promise<Uint8Array> {
  const encrypted = decodeZ85(content);
  const compressed = await decrypt(key, encrypted, aad);
  // Fixed output buffer: fflate never grows a caller-provided buffer, so an
  // over-sized decompression comes back at maxSize + 1 (or throws) and is
  // rejected instead of ballooning memory or truncating silently.
  const plaintext = inflateSync(compressed, {
    out: new Uint8Array(maxSize + 1),
  });
  if (plaintext.length > maxSize) {
    throw new Error('Decompressed chunk exceeds the chunk size');
  }
  return plaintext;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

/**
 * Assemble downloaded chunks into the original file bytes.
 * Throws if any chunk is missing or the total size does not match.
 */
export function assembleChunks(
  chunks: (Uint8Array | null)[],
  fileSize: number,
): Uint8Array {
  const result = new Uint8Array(fileSize);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) throw new Error(`Missing chunk ${i} of ${chunks.length}`);
    if (offset + chunk.length > fileSize) {
      throw new Error('Assembled data exceeds expected file size');
    }
    result.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== fileSize) {
    throw new Error(
      `Assembled size mismatch: expected ${fileSize}, got ${offset}`,
    );
  }
  return result;
}
