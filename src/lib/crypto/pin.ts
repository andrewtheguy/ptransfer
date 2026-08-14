import {
  PBKDF2_HASH,
  PBKDF2_ITERATIONS,
  PIN_CHARSET,
  PIN_CHECKSUM_LENGTH,
  PIN_HINT_LENGTH,
  PIN_HKDF_SALT,
  PIN_LENGTH,
  PIN_LOCATOR_LENGTH,
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
 * Extract the PIN's locator segment: the leading PIN_LOCATOR_LENGTH characters,
 * the only part of the PIN that feeds the published rendezvous hint.
 *
 * Treat the return value as public. It is recoverable from any relay event the
 * sender published (see computePinHintFromLocator), so it is carried alongside
 * the PIN root in PinKeyMaterial rather than guarded like one.
 */
export function getPinLocator(pin: string): string {
  return pin.slice(0, PIN_LOCATOR_LENGTH);
}

/**
 * Derive the PIN root: a non-extractable HKDF key produced by the full
 * PBKDF2-SHA-256 stretch of the PIN with the public PIN_ROOT_SALT.
 *
 * The two secret PIN-scoped values — the claim/confirm auth key and the
 * rendezvous payload key — are cheap HKDF derivations off this root with
 * distinct info labels, so the expensive stretch runs exactly once per PIN
 * while brute-forcing either published ciphertext still costs the full PBKDF2
 * work factor per PIN guess. The rendezvous hint is deliberately *not* one of
 * them: it hangs off the public locator segment instead, so the lookup tag can
 * never be used to confirm a guess at the rest of the PIN.
 *
 * The whole PIN is stretched, locator included. That adds no real strength —
 * the locator is recoverable from the published hint, which is why the honest
 * accounting in constants.ts counts only the remaining characters — but it
 * costs nothing and keeps a wrong locator from producing working seals.
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
 * event. Scoping the info label to the rotation bucket means the published tag
 * is never a stable cross-transfer correlator and pins down which rotation
 * generation an event belongs to.
 *
 * Keyed by the locator segment alone, never by the PIN root. That is the whole
 * point: the tag is public and enumerable either way, so deriving it from the
 * full PIN would only hand an attacker a cheap oracle for confirming guesses at
 * the secret characters. Keying it off the segment that is already public
 * leaves the rest of the PIN reachable only through the AES-GCM seals.
 *
 * A consequence worth remembering at the call site: with roughly 18 bits behind
 * it the hint is a filter, not an identifier. Unrelated transfers in the same
 * bucket do collide, and callers must be prepared to walk several candidates.
 *
 * PBKDF2 is deliberately absent. Stretching a value with 328,509 possible
 * inputs buys nothing, and skipping it lets both sides derive hints without
 * waiting on the PIN root.
 *
 * Callers pass the absolute bucket explicitly so the hint and the sender's
 * recorded acceptance bucket cannot disagree across a boundary.
 */
export async function computePinHintFromLocator(
  locator: string,
  bucket: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const locatorData = encoder.encode(locator);

  let hkdfKey: CryptoKey;
  try {
    hkdfKey = await crypto.subtle.importKey('raw', locatorData, 'HKDF', false, [
      'deriveBits',
    ]);
  } finally {
    wipeBufferSource(locatorData);
  }

  const bits = await crypto.subtle.deriveBits(
    hkdfParams(`hint:${bucket}`),
    hkdfKey,
    Math.ceil(PIN_HINT_LENGTH / 2) * 8,
  );

  return Array.from(new Uint8Array(bits))
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
 * Generate a random transfer ID (16 hex characters)
 */
export function generateTransferId(): string {
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
