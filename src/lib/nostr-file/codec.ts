import { deflateSync, inflateSync } from 'fflate';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { t } from '../i18n';
import { NOSTR_FILE_AAD_PREFIX, NOSTR_FILE_CHUNK_SIZE } from './constants';
import { decodeZ85, encodeZ85 } from './z85';

/** Whole-payload compression applied before chunking. */
export type PayloadCompression = 'deflate' | 'none';

/**
 * Compress the whole file once, before chunking. Deflating the entire file
 * instead of each chunk lets a highly compressible file collapse into a few
 * chunks rather than one event per 48 KiB of plaintext.
 *
 * The caller decides, by flow and file type rather than by sniffing content
 * (see `wireEncodingFor`): a `precompressed` payload — a ZIP whose entries
 * are already deflated, or a file whose format is compressed, such as audio
 * or video — is never recompressed ('none'); every other payload is always
 * deflated, whether or not that shrinks it.
 */
export function compressPayload(
  data: Uint8Array,
  precompressed: boolean,
): {
  payload: Uint8Array;
  compression: PayloadCompression;
} {
  if (precompressed) return { payload: data, compression: 'none' };
  // The fastest level: this runs on the page's own thread, over the whole
  // file at once, and it is time the transfer waits on.
  return { payload: deflateSync(data, { level: 1 }), compression: 'deflate' };
}

/**
 * Reverse compressPayload on the assembled payload. `fileSize` is the exact
 * plaintext size the manifest promised: it bounds the inflate output
 * (decompression-bomb guard) and anything but an exact match throws.
 */
export function decompressPayload(
  payload: Uint8Array,
  compression: PayloadCompression,
  fileSize: number,
): Uint8Array {
  if (compression === 'none') {
    if (payload.length !== fileSize) {
      throw new Error(
        t({
          en: `Payload size mismatch: expected ${fileSize}, got ${payload.length}`,
          es: `El tamaño de la carga no coincide: se esperaban ${fileSize} y llegaron ${payload.length}`,
        }),
      );
    }
    return payload;
  }
  // Fixed output buffer: fflate never grows a caller-provided buffer, so an
  // over-sized decompression comes back at fileSize + 1 (or throws) and is
  // rejected instead of ballooning memory or truncating silently.
  const plaintext = inflateSync(payload, {
    out: new Uint8Array(fileSize + 1),
  });
  if (plaintext.length !== fileSize) {
    throw new Error(
      t({
        en: `Decompressed size mismatch: expected ${fileSize}, got ${plaintext.length}`,
        es: `El tamaño descomprimido no coincide: se esperaban ${fileSize} y llegaron ${plaintext.length}`,
      }),
    );
  }
  return plaintext;
}

/**
 * Split payload bytes into fixed-size chunks (last chunk may be shorter).
 */
export function splitIntoChunks(
  data: Uint8Array,
  chunkSize: number,
): Uint8Array[] {
  if (chunkSize <= 0) {
    throw new Error(
      t({
        en: 'chunkSize must be positive',
        es: 'chunkSize debe ser positivo',
      }),
    );
  }
  if (data.length === 0) {
    throw new Error(
      t({
        en: 'cannot chunk empty data',
        es: 'no se pueden fragmentar datos vacíos',
      }),
    );
  }
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
 * Payload chunk -> nostr event content string.
 * Pipeline: AES-256-GCM (nonce||ct||tag, AAD-bound) -> Z85 (base85: smaller
 * than base64 and JSON-escape-free). Compression happens once over the whole
 * payload before chunking (compressPayload), not per chunk.
 */
export async function encodeChunkContent(
  key: CryptoKey,
  chunk: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const encrypted = await encrypt(key, chunk, undefined, aad);
  return encodeZ85(encrypted);
}

/**
 * Nostr event content string -> payload chunk.
 * Throws on tampering (GCM auth failure), wrong AAD, or a chunk larger than
 * maxSize.
 */
export async function decodeChunkContent(
  key: CryptoKey,
  content: string,
  aad: Uint8Array,
  maxSize: number = NOSTR_FILE_CHUNK_SIZE,
): Promise<Uint8Array> {
  const encrypted = decodeZ85(content);
  const chunk = await decrypt(key, encrypted, aad);
  if (chunk.length > maxSize) {
    throw new Error(
      t({
        en: 'Chunk exceeds the chunk size',
        es: 'El fragmento supera el tamaño de fragmento',
      }),
    );
  }
  return chunk;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

/**
 * Assemble downloaded chunks into the original payload bytes.
 * Throws if any chunk is missing or the total size does not match.
 */
export function assembleChunks(
  chunks: (Uint8Array | null)[],
  payloadSize: number,
): Uint8Array {
  const result = new Uint8Array(payloadSize);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) {
      throw new Error(
        t({
          en: `Missing chunk ${i} of ${chunks.length}`,
          es: `Falta el fragmento ${i} de ${chunks.length}`,
        }),
      );
    }
    if (offset + chunk.length > payloadSize) {
      throw new Error(
        t({
          en: 'Assembled data exceeds expected payload size',
          es: 'Los datos ensamblados superan el tamaño de carga esperado',
        }),
      );
    }
    result.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== payloadSize) {
    throw new Error(
      t({
        en: `Assembled size mismatch: expected ${payloadSize}, got ${offset}`,
        es: `El tamaño ensamblado no coincide: se esperaban ${payloadSize} y llegaron ${offset}`,
      }),
    );
  }
  return result;
}
