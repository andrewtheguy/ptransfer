import { p256 } from '@noble/curves/nist.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { wipeBufferSource } from './memory';

/**
 * SPAKE2 (RFC 9382) over P-256 for the Nostr-mode PIN handshake.
 *
 * A balanced PAKE is what removes the offline attack surface the old
 * PBKDF2-sealed handshake had to out-muscle: the published SPAKE2 elements are
 * password-blinded group elements, so a relay transcript is information-
 * theoretically useless for testing PIN guesses. The only way to test a guess
 * is a live protocol run, which the sender counts and caps
 * (CLAIM_VERIFY_LIMIT).
 *
 * Web Crypto has no group operations, so the group math runs in @noble/curves
 * and the shared secret transits JavaScript memory briefly. That is an
 * accepted trade: every secret involved — the PIN, the ephemeral scalars, the
 * transcript key — is transfer-scoped and dead minutes later. The digest is
 * locked into a non-extractable HKDF CryptoKey as the very next step and the
 * intermediate bytes are wiped; the bigint scalars cannot be wiped (JS gives
 * no way to zero a bigint) and are simply dropped.
 *
 * Roles are fixed: the transfer sender is SPAKE2's A (blinds with M), the
 * receiver is B (blinds with N).
 */

const Point = p256.Point;

/** Compressed SEC1 point size — the wire size of every SPAKE2 element. */
export const PAKE_MESSAGE_LENGTH = 33;

/**
 * RFC 9382 nothing-up-my-sleeve constants for P-256, generated in the RFC by
 * hashing a fixed seed string to the curve so nobody knows their discrete
 * logs. Knowing dlog(M) or dlog(N) is what would let a man-in-the-middle
 * unblind an element and mount an offline dictionary attack, so these must be
 * the standard constants, never home-grown points.
 */
const M = Point.fromHex(
  '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f',
);
const N = Point.fromHex(
  '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49',
);

/** Versioned domain separators. Bump with any change to the TT layout. */
const PAKE_CONTEXT = 'secure-send:spake2-p256:v3';
const PAKE_SECRET_SALT = 'secure-send:spake2-w:v3';

export type PakeRole = 'sender' | 'receiver';

/**
 * Derive the SPAKE2 password scalar w from the PIN: HKDF-SHA256 stretched to
 * 384 bits and reduced mod the group order, returned as 32 big-endian bytes.
 *
 * There is deliberately no expensive KDF here. A password-hardening function
 * only helps when some artifact allows offline guessing, and the whole point
 * of the PAKE is that none does — so stretching would add latency for zero
 * security. The 384-bit intermediate makes the mod-n reduction bias
 * negligible.
 *
 * The whole PIN goes in, locator included. The locator is public (it is
 * recoverable from the published hint), so it adds no strength — the honest
 * accounting in constants.ts counts only the secret characters — but it costs
 * nothing and keeps a wrong locator from producing a working handshake.
 */
export async function derivePakeSecret(pin: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const pinData = encoder.encode(pin);

  let hkdfKey: CryptoKey;
  try {
    hkdfKey = await crypto.subtle.importKey('raw', pinData, 'HKDF', false, [
      'deriveBits',
    ]);
  } finally {
    wipeBufferSource(pinData);
  }

  const wide = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(PAKE_SECRET_SALT),
        info: encoder.encode('w'),
      },
      hkdfKey,
      384,
    ),
  );

  try {
    let w = bytesToNumberBE(wide) % Point.Fn.ORDER;
    // w = 0 has probability ~2^-384; map it to a valid scalar anyway so the
    // function is total.
    if (w === 0n) w = 1n;
    return numberToBytesBE(w, 32);
  } finally {
    wipeBufferSource(wide);
  }
}

function readPakeScalar(pakeSecret: Uint8Array, name: string): bigint {
  const value = bytesToNumberBE(pakeSecret);
  if (value <= 0n || value >= Point.Fn.ORDER) {
    throw new Error(`Invalid ${name}: not a reduced nonzero group scalar`);
  }
  return value;
}

export interface PakeStart {
  /** The blinded element to publish: pA (sender) or pB (receiver). */
  message: Uint8Array;
  /**
   * The ephemeral secret scalar (x or y), consumed by finishPake. Never
   * serialized or published.
   */
  secret: bigint;
}

/**
 * Start a SPAKE2 run: pick a fresh ephemeral scalar and produce this side's
 * blinded element (pA = x·G + w·M for the sender, pB = y·G + w·N for the
 * receiver).
 *
 * The sender runs this once per PIN generation; the receiver runs it once per
 * rendezvous candidate it claims. Fresh scalars per run are what make every
 * published element single-use — nothing replays across rotations, transfers,
 * or candidates.
 */
export function startPake(role: PakeRole, pakeSecret: Uint8Array): PakeStart {
  const w = readPakeScalar(pakeSecret, 'PAKE secret');

  const scalarBytes = p256.utils.randomSecretKey();
  const secret = bytesToNumberBE(scalarBytes);
  wipeBufferSource(scalarBytes);

  const blind = (role === 'sender' ? M : N).multiply(w);
  const message = Point.BASE.multiply(secret).add(blind).toBytes(true);
  return { message, secret };
}

/**
 * The values the SPAKE2 transcript binds beyond the group elements. Keying the
 * transcript by both Nostr identities and the transfer id means a relay (or a
 * live-PIN attacker) that re-publishes either side's element under a different
 * identity or transfer derives a *different* session key even though the group
 * math would agree — the seals keyed off this transcript then simply fail.
 */
export interface PakeIdentities {
  transferId: string;
  /** Nostr pubkey of the transfer sender (SPAKE2 A). */
  senderPubkey: string;
  /** Nostr pubkey of the claiming receiver (SPAKE2 B). */
  receiverPubkey: string;
}

function lengthPrefix(data: Uint8Array): Uint8Array[] {
  // 8-byte little-endian length framing per RFC 9382, so no transcript field
  // can shift bytes into a neighbor.
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(data.length), true);
  return [len, data];
}

/**
 * Finish a SPAKE2 run: unblind the peer's element, compute the shared group
 * element K, hash the RFC 9382 transcript
 * TT = len‖Context ‖ len‖idA ‖ len‖idB ‖ len‖pA ‖ len‖pB ‖ len‖K ‖ len‖w
 * and return SHA-256(TT) locked into a non-extractable HKDF CryptoKey.
 *
 * Throws on any invalid peer element (wrong length, not on the curve, or one
 * whose unblinding lands on the identity). A wrong PIN does not throw here —
 * both sides simply derive different root keys, and the mismatch surfaces when
 * a sealed claim or confirm payload fails to open.
 *
 * Everything downstream — the claim/confirm seal keys, the signals and content
 * session keys, and the confirmation code — is an HKDF derivation off the
 * returned root, so proving possession of any of them proves knowledge of the
 * PIN for exactly this (transfer, sender, receiver, elements) tuple.
 */
export async function finishPake(
  role: PakeRole,
  secret: bigint,
  pakeSecret: Uint8Array,
  ownMessage: Uint8Array,
  peerMessage: Uint8Array,
  identities: PakeIdentities,
): Promise<CryptoKey> {
  const w = readPakeScalar(pakeSecret, 'PAKE secret');

  if (peerMessage.length !== PAKE_MESSAGE_LENGTH) {
    throw new Error('Invalid PAKE message length');
  }
  // fromBytes validates the point is on the curve; P-256 has cofactor 1, so
  // on-curve and non-identity is the full subgroup check.
  const peer = Point.fromBytes(peerMessage);

  const peerBlind = (role === 'sender' ? N : M).multiply(w);
  const unblinded = peer.subtract(peerBlind);
  if (unblinded.is0()) {
    throw new Error('Invalid PAKE message: unblinds to the identity');
  }
  const K = unblinded.multiply(secret).toBytes(true);

  const pA = role === 'sender' ? ownMessage : peerMessage;
  const pB = role === 'sender' ? peerMessage : ownMessage;

  const encoder = new TextEncoder();
  const parts = [
    ...lengthPrefix(encoder.encode(`${PAKE_CONTEXT}|${identities.transferId}`)),
    ...lengthPrefix(encoder.encode(identities.senderPubkey)),
    ...lengthPrefix(encoder.encode(identities.receiverPubkey)),
    ...lengthPrefix(pA),
    ...lengthPrefix(pB),
    ...lengthPrefix(K),
    ...lengthPrefix(pakeSecret),
  ];
  const transcript = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    transcript.set(part, offset);
    offset += part.length;
  }
  wipeBufferSource(K);

  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', transcript),
  );
  wipeBufferSource(transcript);

  try {
    return await crypto.subtle.importKey('raw', digest, 'HKDF', false, [
      'deriveBits',
      'deriveKey',
    ]);
  } finally {
    wipeBufferSource(digest);
  }
}

/**
 * Cheap structural check for an incoming wire element, for use before
 * committing to the heavier finishPake work: correct length and a valid
 * non-identity curve point.
 */
export function isValidPakeMessage(message: Uint8Array): boolean {
  if (message.length !== PAKE_MESSAGE_LENGTH) return false;
  try {
    return !Point.fromBytes(message).is0();
  } catch {
    return false;
  }
}
