import {
  NOSTR_FILE_EXPIRATION_SEC,
  NOSTR_FILE_MANIFEST_VERSION,
  NOSTR_FILE_MAX_BYTES,
} from './constants';

/**
 * Retrieval metadata for a file relayed through nostr. The sender builds it
 * once the fallback starts (it needs the file hashed and chunked) and sends
 * it as the first message of the encrypted control channel — it never
 * appears in a code and relays only ever see it sealed. The transfer id and
 * control relays are session-level (see `session.ts`) and not repeated here.
 * Chunk event `d` tags are derived (`<transferId>:<index>`) so no per-chunk
 * pointers are needed; integrity comes from per-chunk AES-GCM tags plus the
 * whole-file hash, authenticity from nostr signatures under `pubkey`.
 */
export interface NostrFileManifest {
  v: typeof NOSTR_FILE_MANIFEST_VERSION;
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** base64(sha256 of plaintext) — whole-file verification after assembly */
  fileHash: string;
  /** 64 hex chars — ephemeral nostr pubkey; authors filter + signature auth */
  pubkey: string;
  /**
   * Whole-payload compression applied before chunking, decided by flow, not
   * content: 'none' marks a payload the multi-file/folder flow already
   * compressed (a ZIP with deflated entries — never recompressed), 'deflate'
   * a single-file payload deflated once as a whole, whether or not that
   * shrank it.
   */
  compression: 'deflate' | 'none';
  /** bytes actually chunked onto relays: deflate output size (which may
   * slightly exceed fileSize for incompressible input), or fileSize when
   * compression is 'none' */
  payloadSize: number;
  chunkSize: number;
  totalChunks: number;
  /** codec version: 2 = whole-payload deflate + AES-256-GCM (nonce||ct||tag)
   * + Z85 per chunk */
  enc: 2;
  /** unix seconds */
  createdAt: number;
  /** unix seconds; createdAt + NOSTR_FILE_EXPIRATION_SEC */
  expiresAt: number;
}

const HEX_64 = /^[0-9a-f]{64}$/;
// base64 of 32 bytes: 43 chars + '=' padding
export const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 65408;

export function isValidNostrFileManifest(
  value: unknown,
): value is NostrFileManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;

  if (m.v !== NOSTR_FILE_MANIFEST_VERSION) return false;
  if (m.enc !== 2) return false;

  if (typeof m.fileName !== 'string' || m.fileName.length === 0) return false;
  if (typeof m.mimeType !== 'string') return false;

  if (
    typeof m.fileSize !== 'number' ||
    !Number.isInteger(m.fileSize) ||
    m.fileSize <= 0 ||
    m.fileSize > NOSTR_FILE_MAX_BYTES
  ) {
    return false;
  }

  if (m.compression !== 'deflate' && m.compression !== 'none') return false;

  // 'none' chunks exactly the file bytes; 'deflate' output can exceed the
  // plaintext for incompressible input, but never by more than raw deflate's
  // worst case (5 bytes of stored-block framing per 64 KiB, plus slack).
  const maxDeflatedSize = m.fileSize + Math.ceil(m.fileSize / 65535) * 5 + 64;
  if (
    typeof m.payloadSize !== 'number' ||
    !Number.isInteger(m.payloadSize) ||
    m.payloadSize <= 0 ||
    (m.compression === 'none'
      ? m.payloadSize !== m.fileSize
      : m.payloadSize > maxDeflatedSize)
  ) {
    return false;
  }

  if (
    typeof m.chunkSize !== 'number' ||
    !Number.isInteger(m.chunkSize) ||
    m.chunkSize < MIN_CHUNK_SIZE ||
    m.chunkSize > MAX_CHUNK_SIZE
  ) {
    return false;
  }

  if (
    typeof m.totalChunks !== 'number' ||
    !Number.isInteger(m.totalChunks) ||
    m.totalChunks !== Math.ceil(m.payloadSize / m.chunkSize)
  ) {
    return false;
  }

  if (typeof m.fileHash !== 'string' || !BASE64_32_BYTES.test(m.fileHash)) {
    return false;
  }
  if (typeof m.pubkey !== 'string' || !HEX_64.test(m.pubkey)) return false;

  if (
    typeof m.createdAt !== 'number' ||
    !Number.isInteger(m.createdAt) ||
    typeof m.expiresAt !== 'number' ||
    !Number.isInteger(m.expiresAt) ||
    m.expiresAt !== m.createdAt + NOSTR_FILE_EXPIRATION_SEC
  ) {
    return false;
  }

  return true;
}
