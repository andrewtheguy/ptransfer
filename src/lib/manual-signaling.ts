import { deflateSync, inflateSync } from 'fflate';
import {
  BASE64_32_BYTES,
  isValidNostrFileManifest,
  type NostrFileManifest,
} from './nostr-file/manifest';

// Deterministic deflate helpers (avoid browser stream API stalls).
function deflateCompress(data: Uint8Array): Uint8Array {
  return deflateSync(data);
}

function deflateDecompress(data: Uint8Array): Uint8Array {
  return inflateSync(data);
}

// Magic header: "PT01" = pTransfer manual-signaling format version 1
const MAGIC_HEADER_V1 = new Uint8Array([0x50, 0x54, 0x30, 0x31]);
// Inner magic: "mag!" - inside the obfuscated area to verify the seed
const INNER_MAGIC_V3 = new Uint8Array([0x6d, 0x61, 0x67, 0x21]);
const BUCKET_SEC = 3600; // 1 hour
const BASE_SEED = 0x9e3779b9;

function getSeedForBucket(bucketEpoch: number): number {
  // Simple hash of bucket index
  let h = BASE_SEED ^ bucketEpoch;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

/**
 * the goal of obfuscation is simply to avoid casual inspection
 */
function xorObfuscate(data: Uint8Array, seed: number): Uint8Array {
  let state = seed;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    state = xorshift32(state);
    out[i] = data[i] ^ (state & 0xff);
  }
  return out;
}

/**
 * Signaling Payload - method-agnostic format for Manual Exchange mode
 * Used by both QR scan and copy/paste methods
 */
export interface SignalingPayload {
  type: 'offer' | 'answer';
  sdp: string;
  candidates: string[]; // ICE candidates as SDP strings
  // Milliseconds since epoch when this payload was generated (TTL enforced by receiver for offers).
  createdAt: number;
  // ECDH public key for mutual exchange (65 bytes P-256 uncompressed)
  publicKey: number[];
  // Offer-only fields:
  fileName?: string;
  fileSize?: number;
  fileSizeExact?: boolean;
  mimeType?: string;
  salt?: number[]; // Salt for content encryption key derivation (from ECDH shared secret)
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode any manual-exchange payload object into the PT01 container:
 * [PT01][xorObfuscate([mag!][deflate(JSON)], hourly seed)]
 */
function encodeManualPayload(payload: object): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = deflateCompress(jsonBytes);

  // Build inner: [mag!][compressed]
  const inner = new Uint8Array(4 + compressed.length);
  inner.set(INNER_MAGIC_V3, 0);
  inner.set(compressed, 4);

  const currentBucket = Math.floor(Date.now() / 1000 / BUCKET_SEC);
  const seed = getSeedForBucket(currentBucket);
  const obfuscatedInner = xorObfuscate(inner, seed);

  // Final binary: [PT01][obfuscatedInner]
  const result = new Uint8Array(4 + obfuscatedInner.length);
  result.set(MAGIC_HEADER_V1, 0);
  result.set(obfuscatedInner, 4);
  return result;
}

/**
 * Decode a PT01 container back to the parsed JSON value, trying the current
 * and previous hourly seed buckets. Returns null on any mismatch.
 */
function decodeManualPayload(binary: Uint8Array): unknown {
  if (!isMutualPayload(binary)) {
    return null;
  }

  const obfuscatedInner = binary.subarray(4);
  const currentBucket = Math.floor(Date.now() / 1000 / BUCKET_SEC);

  // Try current and previous bucket (approx 2 hours window)
  for (let i = 0; i <= 1; i++) {
    try {
      const seed = getSeedForBucket(currentBucket - i);

      // Optimization: check inner magic first (de-obfuscate only first 4 bytes)
      const innerHead = xorObfuscate(obfuscatedInner.subarray(0, 4), seed);
      if (
        innerHead[0] !== INNER_MAGIC_V3[0] ||
        innerHead[1] !== INNER_MAGIC_V3[1] ||
        innerHead[2] !== INNER_MAGIC_V3[2] ||
        innerHead[3] !== INNER_MAGIC_V3[3]
      ) {
        continue;
      }

      const deobfuscated = xorObfuscate(obfuscatedInner, seed);
      const compressed = deobfuscated.slice(4); // Skip INNER_MAGIC_V3
      const jsonBytes = deflateDecompress(compressed);
      const json = new TextDecoder().decode(jsonBytes);
      return JSON.parse(json) as unknown;
    } catch {}
  }

  return null;
}

/**
 * Parse base64 clipboard data to binary payload
 */
export function parseClipboardPayload(base64: string): Uint8Array | null {
  try {
    return base64ToUint8Array(base64);
  } catch {
    return null;
  }
}

/**
 * Validate SignalingPayload structure
 */
export function isValidSignalingPayload(
  payload: unknown,
): payload is SignalingPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'offer' && p.type !== 'answer') return false;
  if (typeof p.sdp !== 'string') return false;
  if (!Array.isArray(p.candidates)) return false;
  if (!(p.candidates as unknown[]).every((c) => typeof c === 'string'))
    return false;
  if (!Number.isFinite(p.createdAt)) return false;
  if (!isValidPublicKeyArray(p.publicKey)) return false;
  return true;
}

/**
 * Validate binary payload has the pTransfer version 1 magic header
 */
export function isValidBinaryPayload(binary: Uint8Array): boolean {
  return isMutualPayload(binary);
}

/**
 * Estimate compressed payload size in bytes (includes PT01 magic header)
 */
export function estimatePayloadSize(payload: SignalingPayload): number {
  const json = JSON.stringify(payload);
  const compressed = deflateCompress(new TextEncoder().encode(json));
  return 4 + 4 + compressed.length; // 4 for PT01, 4 for INNER_MAGIC_V3
}

/**
 * Generate mutual offer as binary data
 * Format: [PT01 magic (4 bytes)][obfuscated compressed payload]
 * NOT encrypted - ECDH public keys are not secret
 */
export function generateMutualOfferBinary(
  offer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  metadata: {
    createdAt: number;
    fileName: string;
    fileSize: number;
    fileSizeExact: boolean;
    mimeType: string;
    publicKey: Uint8Array; // ECDH public key (65 bytes)
    salt: Uint8Array; // Salt for AES key derivation
  },
): Uint8Array {
  const payload: SignalingPayload = {
    type: 'offer',
    sdp: offer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
    createdAt: metadata.createdAt,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    fileSizeExact: metadata.fileSizeExact,
    mimeType: metadata.mimeType,
    publicKey: Array.from(metadata.publicKey),
    salt: Array.from(metadata.salt),
  };

  return encodeManualPayload(payload);
}

/**
 * Generate mutual answer as binary data
 * Format: [PT01 magic (4 bytes)][obfuscated compressed payload]
 */
export function generateMutualAnswerBinary(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  publicKey: Uint8Array, // ECDH public key (65 bytes)
  createdAt: number = Date.now(),
): Uint8Array {
  const payload: SignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
    createdAt,
    publicKey: Array.from(publicKey),
  };

  return encodeManualPayload(payload);
}

/**
 * Validate publicKey is a valid P-256 uncompressed public key (65 bytes, values 0-255)
 */
export function isValidPublicKeyArray(arr: unknown): arr is number[] {
  if (!Array.isArray(arr) || arr.length !== 65) return false;
  return arr.every(
    (b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255,
  );
}

/**
 * Parse mutual exchange binary payload (offer or answer)
 * Returns null if invalid format or version
 */
export function parseMutualPayload(
  binary: Uint8Array,
): SignalingPayload | null {
  try {
    const payload = decodeManualPayload(binary);
    if (isValidSignalingPayload(payload)) {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if binary payload is pTransfer mutual exchange format version 1
 */
export function isMutualPayload(binary: Uint8Array): boolean {
  if (binary.length < 8) return false;
  return (
    binary[0] === MAGIC_HEADER_V1[0] &&
    binary[1] === MAGIC_HEADER_V1[1] &&
    binary[2] === MAGIC_HEADER_V1[2] &&
    binary[3] === MAGIC_HEADER_V1[3]
  );
}

/**
 * Generate base64 string for clipboard (mutual exchange)
 */
export function generateMutualClipboardData(binary: Uint8Array): string {
  return uint8ArrayToBase64(binary);
}

/**
 * Live (single-copy) Nostr file relay payload: the manifest of the transfer
 * plus the decryption key, handed out *before* the upload. The sender stays
 * online and the two sides coordinate over an encrypted control channel on
 * the same relays (keyed off `key`), so both need the relays at the same
 * time. Because the key rides in it, this payload must only ever travel over
 * the trusted manual channel (QR / direct copy-paste).
 */
export interface NostrFileLivePayload extends NostrFileManifest {
  type: 'nostr-file-live';
  /** base64(32-byte AES-256-GCM key) */
  key: string;
}

/**
 * Validate NostrFileLivePayload structure
 */
export function isValidNostrFileLivePayload(
  payload: unknown,
): payload is NostrFileLivePayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'nostr-file-live') return false;
  if (typeof p.key !== 'string' || !BASE64_32_BYTES.test(p.key)) {
    return false;
  }
  return isValidNostrFileManifest(payload);
}

/**
 * Generate a nostr file relay payload as PT01 binary data
 */
export function generateNostrFilePayloadBinary(
  payload: NostrFileLivePayload,
): Uint8Array {
  return encodeManualPayload(payload);
}

export type ParsedManualPayload =
  | { kind: 'signaling'; payload: SignalingPayload }
  | { kind: 'nostr-file-live'; payload: NostrFileLivePayload };

/**
 * Parse any manual-exchange PT01 binary and discriminate its payload type.
 * Returns null for unknown or malformed payloads.
 */
export function parseAnyManualPayload(
  binary: Uint8Array,
): ParsedManualPayload | null {
  try {
    const payload = decodeManualPayload(binary);
    if (isValidNostrFileLivePayload(payload)) {
      return { kind: 'nostr-file-live', payload };
    }
    if (isValidSignalingPayload(payload)) {
      return { kind: 'signaling', payload };
    }
    return null;
  } catch {
    return null;
  }
}
