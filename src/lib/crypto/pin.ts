import {
  PIN_CHARSET,
  PIN_CHECKSUM_LENGTH,
  PIN_HINT_HKDF_SALT,
  PIN_HINT_LENGTH,
  PIN_LENGTH,
  PIN_LOCATOR_LENGTH,
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
 * the SPAKE2 secret in PinKeyMaterial rather than guarded like one.
 */
export function getPinLocator(pin: string): string {
  return pin.slice(0, PIN_LOCATOR_LENGTH);
}

function hintHkdfParams(info: string): HkdfParams {
  const encoder = new TextEncoder();
  return {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode(PIN_HINT_HKDF_SALT),
    info: encoder.encode(info),
  };
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
 * Keyed by the locator segment alone, never by the rest of the PIN. That is
 * the whole point: the tag is public and enumerable either way, so deriving it
 * from the full PIN would hand an attacker a cheap oracle for confirming
 * guesses at the secret characters — the one offline foothold the SPAKE2
 * handshake otherwise eliminates. Keying it off the segment that is already
 * public leaves the secret characters testable only through live claims the
 * sender counts.
 *
 * A consequence worth remembering at the call site: with roughly 17.3 bits
 * behind it the hint is a filter, not an identifier. Unrelated transfers in
 * the same bucket do collide, and callers must be prepared to walk several
 * candidates.
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
    hintHkdfParams(`hint:${bucket}`),
    hkdfKey,
    Math.ceil(PIN_HINT_LENGTH / 2) * 8,
  );

  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, PIN_HINT_LENGTH);
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
