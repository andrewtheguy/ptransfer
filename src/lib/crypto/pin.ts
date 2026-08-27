import {
  ANONYMOUS_PIN_LENGTH,
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
 * Which signaling transport a PIN selects.
 *
 * `standard` is the ordinary PIN Exchange PIN: clearnet `wss://` relays.
 * `anonymous` is the one the sender's Anonymous signaling option mints: the
 * same handshake, carried to a disjoint pool of onion-service relays through
 * the browser Tor client.
 *
 * The kind is carried by the PIN's length and nothing else, because the PIN is
 * the only thing the receiver is handed and it has to pick a relay pool before
 * it can look for a sender. See ANONYMOUS_PIN_LENGTH.
 */
export type PinKind = 'standard' | 'anonymous';

/** How long a PIN of each kind is, checksum character included. */
export const PIN_LENGTHS: Record<PinKind, number> = {
  standard: PIN_LENGTH,
  anonymous: ANONYMOUS_PIN_LENGTH,
};

/**
 * Generate a random PIN of the given kind, with checksum.
 *
 * All but the last character are drawn from PIN_CHARSET using rejection
 * sampling to eliminate modulo bias; the final character is a checksum for
 * typo detection.
 */
export function generatePin(kind: PinKind = 'standard'): string {
  const dataLength = PIN_LENGTHS[kind] - PIN_CHECKSUM_LENGTH;

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
 * Which kind of PIN this is, or null if it is not a valid PIN at all.
 *
 * The length decides the kind and the checksum decides validity, so a
 * mistyped character is rejected rather than silently reinterpreted as the
 * other kind: the two lengths are four apart, which no single insertion,
 * deletion, or substitution can bridge.
 */
export function classifyPin(pin: string): PinKind | null {
  const kind = (Object.keys(PIN_LENGTHS) as PinKind[]).find(
    (candidate) => PIN_LENGTHS[candidate] === pin.length,
  );
  if (!kind) return null;
  if (![...pin].every((char) => PIN_CHARSET.includes(char))) return null;

  // Verify checksum
  const data = pin.slice(0, pin.length - PIN_CHECKSUM_LENGTH);
  const expectedChecksum = computeChecksum(data);
  const actualChecksum = pin.slice(-PIN_CHECKSUM_LENGTH);
  return expectedChecksum === actualChecksum ? kind : null;
}

/**
 * Validate PIN format and checksum, of either kind.
 *
 * Callers that accept only one kind — the Tor transport's one-time password is
 * the one today — compare `classifyPin` against it instead.
 */
export function isValidPin(pin: string): boolean {
  return classifyPin(pin) !== null;
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
 * Whether a rendezvous event stamped `createdAtSeconds` (the Nostr
 * `created_at`) is still claimable: the bucket it was published in must be one
 * the sender still honors, which is the same window the receiver derives hints
 * for.
 *
 * Deliberately a bucket test rather than an age test. An age test
 * (`now - created_at <= PIN_TTL_MS`) is unbounded above: an event stamped a
 * year from now has a negative age, so it never expires, and because
 * candidates are considered newest first it also sorts ahead of the real
 * sender and eats the MAX_CLAIM_CANDIDATES budget. Anchoring to the bucket
 * bounds the timestamp in both directions and costs honest peers nothing --
 * the sender stamps `created_at` and derives the `#h` tag from the same clock
 * reading, so a clock skewed far enough to fail this test already skews the
 * hint out of the queried set.
 */
export function isRendezvousFresh(
  createdAtSeconds: number | undefined,
  now = Date.now(),
): boolean {
  if (!createdAtSeconds || !Number.isFinite(createdAtSeconds)) return false;
  return isPinBucketActive(getPinBucket(createdAtSeconds * 1000), now);
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
