import { deflateSync, inflateSync } from 'fflate';
import { ANSWER_CONFIRMATION_BYTES } from './crypto/constants';
import { normalizeRelayUrl } from './nostr/relays';
import {
  CONTROL_RELAY_COUNT,
  MIN_CONTROL_RELAYS,
} from './nostr-file/constants';
import type { WireEncoding } from './transfer-source';

/** Relays an offer may name, at most. */
export const OFFER_RELAY_COUNT = CONTROL_RELAY_COUNT;
/** Fewer usable relays than this and the offer names none. */
export const MIN_OFFER_RELAYS = MIN_CONTROL_RELAYS;

// Deterministic deflate helpers (avoid browser stream API stalls).
function deflateCompress(data: Uint8Array): Uint8Array {
  return deflateSync(data);
}

function deflateDecompress(data: Uint8Array): Uint8Array {
  return inflateSync(data);
}

// Base64 of ANSWER_CONFIRMATION_BYTES: 16 bytes -> 22 characters plus '=='.
const ANSWER_CONFIRMATION_B64_LENGTH =
  Math.ceil(ANSWER_CONFIRMATION_BYTES / 3) * 4;
const ANSWER_CONFIRMATION_B64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Magic header: "PT01" = pTransfer Code Exchange signaling format version 1
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
 * Signaling Payload - method-agnostic format for Code Exchange
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
  /**
   * Answer-only. Base64 key-confirmation tag over the ECDH shared secret,
   * bound to a digest of the offer container the receiver acted on and to a
   * digest of this answer's own fields (see deriveAnswerConfirmation). The
   * sender recomputes both and refuses the answer unless the tag matches, so
   * an answer that belongs to another transfer, that never passed through a
   * peer holding this offer, or that was altered on the way back is rejected
   * before any signal is applied.
   */
  confirm?: string;
  // Offer-only fields:
  fileName?: string;
  /** Input size of the payload; a progress hint, never the wire length. */
  fileSize?: number;
  /** 'deflate-raw' payloads are inflated by the receiver after decryption. */
  contentEncoding?: WireEncoding;
  mimeType?: string;
  salt?: number[]; // Salt for content encryption key derivation (from ECDH shared secret)
  /**
   * Offer-only, and only when relays were proven before the code was made:
   * the control relays of the Nostr file-relay fallback, used if the direct
   * WebRTC connection fails. Signaling itself is always carried by hand —
   * the answer goes back by QR or copy/paste, never over these relays.
   */
  relays?: string[];
  /**
   * Offer-only, and only ever `true`: this transfer's fallback runs inside
   * Tor rather than on the clearnet — the control channel on the onion relay
   * pool both sides already hold, and the file over an onion service the
   * sending tab publishes. It never travels with a `relays` list, because the
   * pool is a constant on both sides and no clearnet relay takes part.
   *
   * It is the sender's switch, carried here because the receiving page has
   * nothing to turn on: the offer is what tells it which fallback to prepare
   * for, and which one to spend a Tor bootstrap on. Editing the flag in
   * transit does not go unnoticed — the answer's confirmation tag is bound to
   * a digest of the offer container, so the sender refuses a response built
   * on an offer that is not the one it made.
   */
  anon?: true;
}

/** Offer-side validation of the relay list the receiver is asked to use. */
export function normalizeOfferRelays(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > OFFER_RELAY_COUNT) return null;
  const relays: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length >= 200) return null;
    const normalized = normalizeRelayUrl(entry);
    if (normalized === null || relays.includes(normalized)) return null;
    relays.push(normalized);
  }
  return relays.length >= MIN_OFFER_RELAYS ? relays : null;
}

/**
 * The fallback relays an offer names, or null when it names none. A
 * malformed relay list invalidates the whole offer (see
 * isValidSignalingPayload), so this only ever sees well-formed input.
 */
export function relaysFromOffer(payload: SignalingPayload): string[] | null {
  if (payload.type !== 'offer' || payload.relays === undefined) return null;
  return normalizeOfferRelays(payload.relays);
}

/** Whether this offer asks for the Tor fallback rather than the clearnet one. */
export function isAnonymousOffer(payload: SignalingPayload): boolean {
  return payload.type === 'offer' && payload.anon === true;
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
 * Encode any Code Exchange payload object into the PT01 container:
 * [PT01][xorObfuscate([mag!][deflate(JSON)], hourly seed)]
 */
function encodeCodePayload(payload: object): Uint8Array {
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
function decodeCodePayload(binary: Uint8Array): unknown {
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
 * Digest of the exact offer container the two sides must agree on.
 *
 * The input is the PT01 bytes themselves, not a re-serialization of the parsed
 * fields: every path hands the container through unmodified (copy/paste is
 * base64 of these bytes, and the chunked QR path reassembles them under a
 * CRC32 check), so hashing the bytes commits to everything the offer carried,
 * including fields a future reader would not know to canonicalize.
 */
export async function computeOfferTranscriptHash(
  offerBinary: Uint8Array,
): Promise<string> {
  return sha256Hex(offerBinary as BufferSource);
}

const ANSWER_TRANSCRIPT_LABEL = 'ptransfer:code-exchange-answer-transcript:v1';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: BufferSource): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

/**
 * Digest of an answer's own contents: every field the sender acts on, and only
 * those. The confirmation tag is bound to this, so editing an answer's SDP or
 * ICE candidates in transit — leaving its public key and tag intact — makes
 * the sender derive a different tag and reject it.
 *
 * Unlike the offer digest this cannot hash the container bytes: the tag lives
 * inside them, so it would have to cover itself. It hashes a canonical JSON
 * array instead, which fixes element order here rather than depending on key
 * ordering, and whose string escaping means no field value can forge a
 * delimiter into another. The `confirm` field is excluded by construction;
 * fields outside this list do not exist in the format — every offer-only one
 * is rejected on an answer — and no consumer reads any.
 */
export async function computeAnswerTranscriptHash(
  payload: SignalingPayload,
): Promise<string> {
  const canonical = JSON.stringify([
    ANSWER_TRANSCRIPT_LABEL,
    payload.type,
    payload.sdp,
    payload.candidates,
    payload.createdAt,
    toHex(Uint8Array.from(payload.publicKey)),
  ]);

  return sha256Hex(new TextEncoder().encode(canonical));
}

/** Base64 of the raw confirmation tag, as it travels in the answer. */
export function encodeAnswerConfirmation(tag: Uint8Array): string {
  return uint8ArrayToBase64(tag);
}

/**
 * The raw tag an answer carries, or null when the field is missing, not
 * base64, or not exactly ANSWER_CONFIRMATION_BYTES long.
 */
export function decodeAnswerConfirmation(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  if (value.length !== ANSWER_CONFIRMATION_B64_LENGTH) return null;
  if (!ANSWER_CONFIRMATION_B64.test(value)) return null;
  try {
    const bytes = base64ToUint8Array(value);
    return bytes.length === ANSWER_CONFIRMATION_BYTES ? bytes : null;
  } catch {
    return null;
  }
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
  if (!isValidConfirmField(p)) return false;
  if (!isValidAnonField(p)) return false;
  if (!isValidOfferOnlyFields(p)) return false;
  return isValidRelaysField(p);
}

/** The fields only an offer describes: what it is sending, and the salt every
 * derivation off the exchange uses. */
const OFFER_ONLY_FIELDS = [
  'fileName',
  'fileSize',
  'contentEncoding',
  'mimeType',
  'salt',
] as const;

/**
 * Offer-only means every offer-only field, not just the ones that steer a
 * fallback. None of them is covered by the answer transcript the confirmation
 * tag is computed over, so an answer carrying one would arrive correctly
 * tagged and describe a file nothing agreed to.
 */
function isValidOfferOnlyFields(p: Record<string, unknown>): boolean {
  if (p.type === 'offer') return true;
  return OFFER_ONLY_FIELDS.every((field) => p[field] === undefined);
}

/**
 * The anonymous-fallback flag is offer-only and one-valued: `false` would be
 * an offer that says which fallback it is not, which nothing writes and
 * nothing should read, so it is malformed rather than quietly ordinary.
 */
function isValidAnonField(p: Record<string, unknown>): boolean {
  if (p.anon === undefined) return true;
  return p.type === 'offer' && p.anon === true;
}

/**
 * The confirmation tag is answer-only and mandatory there: an answer without
 * one cannot be checked against the offer, so it is malformed rather than
 * merely unverified. An offer carrying one is malformed too — there is nothing
 * earlier for it to be bound to.
 */
function isValidConfirmField(p: Record<string, unknown>): boolean {
  if (p.type === 'offer') return p.confirm === undefined;
  return decodeAnswerConfirmation(p.confirm) !== null;
}

/**
 * The relay list is offer-only: an answer carrying it, or an offer carrying
 * an unusable one, is malformed rather than silently relay-less.
 */
function isValidRelaysField(p: Record<string, unknown>): boolean {
  if (p.relays === undefined) return true;
  if (p.type !== 'offer') return false;
  // The two fallbacks are alternatives, and only the clearnet one names its
  // relays. An offer carrying both would be asking the receiver to pick.
  if (p.anon !== undefined) return false;
  return normalizeOfferRelays(p.relays) !== null;
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
    contentEncoding: WireEncoding;
    mimeType: string;
    publicKey: Uint8Array; // ECDH public key (65 bytes)
    salt: Uint8Array; // Salt for AES key derivation
    /** Omitted when no relay set was proven for the fallback. */
    relays?: string[];
    /**
     * The Tor fallback instead of the clearnet one. Mutually exclusive with
     * `relays`: its relay pool is a constant both sides hold.
     */
    anonymous?: boolean;
  },
): Uint8Array {
  const payload: SignalingPayload = {
    type: 'offer',
    sdp: offer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
    createdAt: metadata.createdAt,
    fileName: metadata.fileName,
    fileSize: metadata.fileSize,
    contentEncoding: metadata.contentEncoding,
    mimeType: metadata.mimeType,
    publicKey: Array.from(metadata.publicKey),
    salt: Array.from(metadata.salt),
    ...(metadata.anonymous
      ? { anon: true as const }
      : metadata.relays
        ? { relays: metadata.relays }
        : {}),
  };

  return encodeCodePayload(payload);
}

/**
 * Produces the key-confirmation tag for an answer whose transcript hashes to
 * `answerTranscriptHash`. In practice this closes over the shared secret and
 * the offer digest and calls deriveAnswerConfirmation.
 */
export type AnswerConfirmationSigner = (
  answerTranscriptHash: string,
) => Promise<Uint8Array>;

/**
 * Generate mutual answer as binary data
 * Format: [PT01 magic (4 bytes)][obfuscated compressed payload]
 *
 * The tag has to cover the exact fields being encoded, so the payload is built
 * first, hashed, and only then handed to `sign` — rather than taking a tag the
 * caller derived from values it believes match. That makes it impossible for
 * the transcript and the encoded answer to drift apart.
 */
export async function generateMutualAnswerBinary(
  answer: RTCSessionDescriptionInit,
  candidates: RTCIceCandidate[],
  publicKey: Uint8Array, // ECDH public key (65 bytes)
  sign: AnswerConfirmationSigner,
  createdAt: number = Date.now(),
): Promise<Uint8Array> {
  const payload: SignalingPayload = {
    type: 'answer',
    sdp: answer.sdp || '',
    candidates: candidates.map((c) => c.candidate),
    createdAt,
    publicKey: Array.from(publicKey),
  };

  const confirmation = await sign(await computeAnswerTranscriptHash(payload));

  return encodeCodePayload({
    ...payload,
    confirm: encodeAnswerConfirmation(confirmation),
  });
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
    const payload = decodeCodePayload(binary);
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
