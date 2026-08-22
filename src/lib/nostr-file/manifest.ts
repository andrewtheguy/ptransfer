import {
  CONTROL_RELAY_COUNT,
  MIN_CONTROL_RELAYS,
  NOSTR_FILE_EXPIRATION_SEC,
  NOSTR_FILE_MANIFEST_VERSION,
  NOSTR_FILE_MAX_BYTES,
} from './constants';

/**
 * Retrieval metadata for a file saved to nostr relays. Travels inside the
 * manually exchanged payload (never published to relays). Chunk event `d`
 * tags are derived (`<transferId>:<index>`) so no per-chunk pointers are
 * needed; integrity comes from per-chunk AES-GCM tags plus the whole-file
 * hash, authenticity from nostr signatures under `pubkey`.
 */
export interface NostrFileManifest {
  v: typeof NOSTR_FILE_MANIFEST_VERSION;
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** base64(sha256 of plaintext) — whole-file verification after assembly */
  fileHash: string;
  /** 32 hex chars (16 random bytes) — d/x tag namespace on relays */
  transferId: string;
  /** 64 hex chars — ephemeral nostr pubkey; authors filter + signature auth */
  pubkey: string;
  chunkSize: number;
  totalChunks: number;
  /** codec version: 1 = deflate + AES-256-GCM (nonce||ct||tag) + Z85 */
  enc: 1;
  /**
   * Relays carrying the encrypted control channel — a small set of proven
   * signaling relays that only ever see control-sized events. The chunk ring
   * is not in the manifest: the sender announces it (and where each chunk
   * landed) over the control channel in every availability message.
   */
  controlRelays: string[];
  /** unix seconds */
  createdAt: number;
  /** unix seconds; createdAt + NOSTR_FILE_EXPIRATION_SEC */
  expiresAt: number;
}

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
// base64 of 32 bytes: 43 chars + '=' padding
export const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;
const MIN_CHUNK_SIZE = 1024;
const MAX_CHUNK_SIZE = 65408;

export function isWssUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'wss:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isValidNostrFileManifest(
  value: unknown,
): value is NostrFileManifest {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;

  if (m.v !== NOSTR_FILE_MANIFEST_VERSION) return false;
  if (m.enc !== 1) return false;

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
    m.totalChunks !== Math.ceil(m.fileSize / m.chunkSize)
  ) {
    return false;
  }

  if (typeof m.fileHash !== 'string' || !BASE64_32_BYTES.test(m.fileHash)) {
    return false;
  }
  if (typeof m.transferId !== 'string' || !HEX_32.test(m.transferId)) {
    return false;
  }
  if (typeof m.pubkey !== 'string' || !HEX_64.test(m.pubkey)) return false;

  if (
    !Array.isArray(m.controlRelays) ||
    m.controlRelays.length < MIN_CONTROL_RELAYS ||
    m.controlRelays.length > CONTROL_RELAY_COUNT ||
    !m.controlRelays.every(
      (r) => typeof r === 'string' && r.length < 200 && isWssUrl(r),
    )
  ) {
    return false;
  }

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
