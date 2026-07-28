import {
  PBKDF2_HASH,
  PBKDF2_ITERATIONS,
  PIN_CHARSET,
  PIN_CHECKSUM_LENGTH,
  PIN_FINGERPRINT_ITERATIONS,
  PIN_FINGERPRINT_LENGTH,
  PIN_FINGERPRINT_SALT,
  PIN_HINT_LENGTH,
  PIN_HKDF_SALT,
  PIN_LENGTH,
  PIN_ROOT_SALT,
  PIN_ROTATION_MS,
} from './constants';
import { wipeBufferSource } from './memory';

/**
 * Compute the checksum character using a position-weighted sum.
 *
 * Each character's alphabet index is weighted by its one-based position.
 */
function computeChecksum(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const charIndex = PIN_CHARSET.indexOf(data[i]);
    sum += charIndex * (i + 1);
  }
  return PIN_CHARSET[sum % PIN_CHARSET.length];
}

/**
 * Generate a random PIN with checksum.
 *
 * PIN_LENGTH - 1 data characters are drawn from PIN_CHARSET using rejection
 * sampling to eliminate modulo bias; the final character is a checksum for
 * typo detection.
 */
export function generatePin(): string {
  const dataLength = PIN_LENGTH - PIN_CHECKSUM_LENGTH;

  const n = PIN_CHARSET.length;
  const maxMultiple = Math.floor(256 / n) * n;

  const result: string[] = [];
  const buffer = new Uint8Array(dataLength * 2);

  while (result.length < dataLength) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte < maxMultiple) {
        result.push(PIN_CHARSET[byte % n]);
        if (result.length === dataLength) break;
      }
    }
  }

  const data = result.join('');
  const checksum = computeChecksum(data);
  return data + checksum;
}

/**
 * Validate PIN format and checksum.
 */
export function isValidPin(pin: string): boolean {
  if (pin.length !== PIN_LENGTH) return false;
  if (![...pin].every((char) => PIN_CHARSET.includes(char))) return false;

  // Verify checksum
  const data = pin.slice(0, PIN_LENGTH - PIN_CHECKSUM_LENGTH);
  const expectedChecksum = computeChecksum(data);
  const actualChecksum = pin.slice(-PIN_CHECKSUM_LENGTH);
  return expectedChecksum === actualChecksum;
}

/**
 * Derive the PIN root: a non-extractable HKDF key produced by the full
 * PBKDF2-SHA-256 stretch of the PIN with the public PIN_ROOT_SALT.
 *
 * Every wire-exposed PIN-scoped value (per-bucket rendezvous hint,
 * claim/confirm auth key, rendezvous payload key) is a cheap HKDF derivation
 * off this root with a distinct info label, so the expensive stretch runs
 * exactly once per PIN while brute-forcing any derived value still costs the
 * full PBKDF2 work factor per PIN guess. The on-screen fingerprint is never
 * transmitted and uses its own light stretch (computePinFingerprint).
 *
 * The PIN root derives no content-encryption keys — file content and WebRTC
 * signaling are protected by keys from the ephemeral ECDH exchange that the
 * PIN merely authenticates.
 *
 * Cleanup note: the encoded PIN bytes and the intermediate derived bits are
 * wiped after import. The original PIN string is managed by the JS engine and
 * cannot be explicitly wiped.
 */
export async function importPinRoot(pin: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const pinData = encoder.encode(pin);

  let pbkdf2Key: CryptoKey;
  try {
    pbkdf2Key = await crypto.subtle.importKey('raw', pinData, 'PBKDF2', false, [
      'deriveBits',
    ]);
  } finally {
    wipeBufferSource(pinData);
  }

  const rootBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: encoder.encode(PIN_ROOT_SALT),
        iterations: PBKDF2_ITERATIONS,
        hash: PBKDF2_HASH,
      },
      pbkdf2Key,
      256,
    ),
  );

  try {
    return await crypto.subtle.importKey('raw', rootBits, 'HKDF', false, [
      'deriveBits',
      'deriveKey',
    ]);
  } finally {
    wipeBufferSource(rootBits);
  }
}

function hkdfParams(info: string): HkdfParams {
  const encoder = new TextEncoder();
  return {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode(PIN_HKDF_SALT),
    info: encoder.encode(info),
  };
}

async function deriveRootBytes(
  root: CryptoKey,
  info: string,
  byteCount: number,
): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    hkdfParams(info),
    root,
    byteCount * 8,
  );
  return new Uint8Array(bits);
}

async function deriveRootAesKey(
  root: CryptoKey,
  info: string,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    hkdfParams(info),
    root,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * The wall-clock rotation bucket used to scope rendezvous hints and PIN
 * acceptance.
 */
export function getPinBucket(now = Date.now()): number {
  return Math.floor(now / PIN_ROTATION_MS);
}

/** Whether a published PIN bucket is current or immediately previous. */
export function isPinBucketActive(bucket: number, now = Date.now()): boolean {
  const currentBucket = getPinBucket(now);
  return bucket === currentBucket || bucket === currentBucket - 1;
}

/**
 * Compute the PIN hint (PIN_HINT_LENGTH hex chars) for a rotation bucket.
 * Published as the Nostr `#h` tag so the receiver can locate the rendezvous
 * event without revealing the PIN. Scoping the info label to the rotation
 * bucket means the published tag is never a stable cross-transfer correlator
 * and pins down which rotation generation an event belongs to.
 *
 * Callers pass the absolute bucket explicitly so the hint and the sender's
 * recorded acceptance bucket cannot disagree across a boundary.
 */
export async function computePinHintFromRoot(
  root: CryptoKey,
  bucket: number,
): Promise<string> {
  const bytes = await deriveRootBytes(
    root,
    `hint:${bucket}`,
    Math.ceil(PIN_HINT_LENGTH / 2),
  );
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, PIN_HINT_LENGTH);
}

/**
 * Derive the PIN auth key: the AES-GCM key that seals the claim/confirm
 * handshake payloads. A payload that decrypts under this key proves the author
 * knows the PIN; the payload contents bind the proof to the transfer, both
 * handshake nonces, and both ECDH public keys, which is what makes the
 * subsequent ECDH-derived session immune to a relay man-in-the-middle.
 */
export async function derivePinAuthKey(root: CryptoKey): Promise<CryptoKey> {
  return deriveRootAesKey(root, 'auth');
}

/**
 * Derive the PIN rendezvous key: the AES-GCM key for the rendezvous event
 * payload (transfer id, sender ECDH public key, handshake nonce, file
 * metadata). Confidentiality here is a privacy measure — recovering the PIN
 * offline reveals this metadata but no content keys.
 */
export async function derivePinRendezvousKey(
  root: CryptoKey,
): Promise<CryptoKey> {
  return deriveRootAesKey(root, 'rendezvous');
}

/**
 * Compute the PIN fingerprint: a stable one-way derivation of the PIN,
 * displayed to both sender and receiver so they can visually confirm they
 * entered the same PIN. Never published to relays — it exists only for human
 * visual comparison, so it carries no rotation-bucket scoping and only a
 * light stretch (PIN_FINGERPRINT_ITERATIONS, independent of the PIN root) —
 * cheap enough to show the moment the PIN is typed.
 *
 * Encoded as PIN_FINGERPRINT_LENGTH lowercase hex chars.
 */
export async function computePinFingerprint(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const pinData = encoder.encode(pin);

  let pbkdf2Key: CryptoKey;
  try {
    pbkdf2Key = await crypto.subtle.importKey('raw', pinData, 'PBKDF2', false, [
      'deriveBits',
    ]);
  } finally {
    wipeBufferSource(pinData);
  }

  const bytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: encoder.encode(PIN_FINGERPRINT_SALT),
        iterations: PIN_FINGERPRINT_ITERATIONS,
        hash: PBKDF2_HASH,
      },
      pbkdf2Key,
      Math.ceil(PIN_FINGERPRINT_LENGTH / 2) * 8,
    ),
  );
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, PIN_FINGERPRINT_LENGTH);
}

/**
 * Format a PIN fingerprint for display: the plain lowercase hex value,
 * ungrouped, so the sender and receiver can visually confirm they derived
 * the same PIN.
 */
export function formatPinHint(hint: string): string {
  return hint.toLowerCase();
}

/**
 * Generate a random transfer ID (16 hex characters)
 */
export function generateTransferId(): string {
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
