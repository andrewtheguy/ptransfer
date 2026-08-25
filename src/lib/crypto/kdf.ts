import { encodeCrockfordBase32 } from './base32';
import {
  AES_KEY_LENGTH,
  ANSWER_CONFIRMATION_BYTES,
  CONFIRMATION_CODE_BYTES,
  SALT_LENGTH,
} from './constants';

/**
 * Session keys for PIN Exchange, derived from the SPAKE2 root
 * key established by the PIN handshake (see spake2.ts). The SPAKE2 output
 * already mixes fresh ephemeral scalars from both sides, so it is the
 * transfer's ephemeral shared secret — there is no separate ECDH exchange in
 * this mode.
 */
export interface PinSessionKeys {
  /** Encrypts relay-carried WebRTC signaling (offer/answer/candidates). */
  signals: CryptoKey;
  /** Encrypts P2P file content chunks on the data channel. */
  content: CryptoKey;
}

/**
 * The AES-GCM keys that seal the two handshake payloads. Successfully sealing
 * or opening under either one is the key-confirmation step of the PAKE: only
 * a peer that ran this exact SPAKE2 session — same PIN, same elements, same
 * identities, same transfer — holds them.
 */
export interface HandshakeSealKeys {
  /** Seals the receiver's claim payload (receiver -> sender). */
  claimKey: CryptoKey;
  /** Seals the sender's confirm payload, metadata included (sender -> receiver). */
  confirmKey: CryptoKey;
}

const SESSION_KEY_LABELS = {
  signals: 'ptransfer:nostr-session:v4:signals',
  content: 'ptransfer:nostr-session:v4:content',
} as const satisfies Record<keyof PinSessionKeys, string>;

const HANDSHAKE_KEY_LABELS = {
  claimKey: 'ptransfer:nostr-session:v4:claim',
  confirmKey: 'ptransfer:nostr-session:v4:confirm',
} as const satisfies Record<keyof HandshakeSealKeys, string>;

async function deriveSessionKey(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  if (salt.length < SALT_LENGTH) {
    throw new Error(
      `Salt too short: expected at least ${SALT_LENGTH} bytes, got ${salt.length}`,
    );
  }

  const encoder = new TextEncoder();
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: encoder.encode(info),
    },
    sharedSecretKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derive the PIN Exchange session keys from the non-extractable HKDF root
 * returned by finishPake (spake2.ts) and the public per-transfer salt.
 * Distinct HKDF info labels guarantee signaling and content never reuse the
 * same AES-GCM key.
 */
export async function derivePinSessionKeys(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
): Promise<PinSessionKeys> {
  const [signals, content] = await Promise.all([
    deriveSessionKey(sharedSecretKey, salt, SESSION_KEY_LABELS.signals),
    deriveSessionKey(sharedSecretKey, salt, SESSION_KEY_LABELS.content),
  ]);

  return { signals, content };
}

/**
 * Derive the claim/confirm seal keys from the SPAKE2 root. Distinct labels
 * per direction (plus the `type` field inside each payload) rule out
 * reflecting one side's sealed payload back as the other's.
 */
export async function deriveHandshakeSealKeys(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
): Promise<HandshakeSealKeys> {
  const [claimKey, confirmKey] = await Promise.all([
    deriveSessionKey(sharedSecretKey, salt, HANDSHAKE_KEY_LABELS.claimKey),
    deriveSessionKey(sharedSecretKey, salt, HANDSHAKE_KEY_LABELS.confirmKey),
  ]);

  return { claimKey, confirmKey };
}

const CONFIRMATION_CODE_LABEL = 'ptransfer:nostr-session:v4:confirmation';

/**
 * The handshake values a confirmation code is bound to, so that a code proves
 * agreement on *this* claim rather than merely on a shared secret.
 */
export interface ConfirmationCodeBinding {
  transferId: string;
  /** Sender's per-rotation nonce, from the rendezvous payload. */
  senderNonce: string;
  /** Receiver's per-claim nonce. */
  receiverNonce: string;
  /**
   * Digest of the rendezvous both peers believe they are acting on — sender
   * identity, SPAKE2 element, salt, and relay hints (see nostr/transcript.ts).
   * The SPAKE2 transcript already keys the root by identities and elements;
   * this extends the agreement to every plaintext rendezvous field.
   */
  transcriptHash: string;
  /**
   * Digest of the file metadata the sender delivered inside its sealed
   * confirm (see computeTransferMetadataHash). Metadata travels after the
   * handshake rather than in the rendezvous, so it is bound here — the code
   * the humans compare attests to *what* is being transferred, not only to
   * the key exchange.
   */
  metadataHash: string;
}

/**
 * Derive the confirmation code both peers show to their humans: a short
 * authentication string over the SPAKE2 root key.
 *
 * The receiver computes it once the sender's confirm verifies — which proved
 * the sender ran the same PAKE session — and displays it. The sender computes
 * the same value from the claim it locked onto and refuses to publish any
 * WebRTC signaling, or send a single file byte, until its operator types a
 * code that matches. Since the code is keyed by the SPAKE2 shared secret,
 * only the peer holding the matching session can produce it, so someone who
 * front-ran the intended receiver with a stolen PIN wins the claim race and
 * then has nothing to say when the sender asks for the code.
 *
 * Binding in the transfer id and both nonces stops a code captured from one
 * rotation, transfer, or direction from being replayed into another. Binding
 * in the rendezvous transcript and the metadata digest extends the guarantee
 * to *what* is being transferred and *who* published it, which a shared
 * secret alone says nothing about.
 */
export async function deriveConfirmationCode(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
  binding: ConfirmationCodeBinding,
): Promise<string> {
  if (salt.length < SALT_LENGTH) {
    throw new Error(
      `Salt too short: expected at least ${SALT_LENGTH} bytes, got ${salt.length}`,
    );
  }

  // transferId and both hashes are hex and both nonces are fixed-length
  // base64, so '|' cannot appear inside a field and the join is unambiguous.
  const info = [
    CONFIRMATION_CODE_LABEL,
    binding.transferId,
    binding.senderNonce,
    binding.receiverNonce,
    binding.transcriptHash,
    binding.metadataHash,
  ].join('|');

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode(info),
    },
    sharedSecretKey,
    CONFIRMATION_CODE_BYTES * 8,
  );

  return encodeCrockfordBase32(new Uint8Array(bits));
}

const ANSWER_CONFIRMATION_LABEL = 'ptransfer:code-exchange:v1:answer-confirm';

/**
 * Derive the Code Exchange answer confirmation tag: the key-confirmation value
 * the receiver puts in its answer and the sender recomputes before it acts on
 * that answer.
 *
 * The tag is keyed by the ECDH shared secret and bound to a digest of the
 * exact offer container the receiver read (see computeOfferTranscriptHash in
 * code-signaling.ts), so producing one requires having held that offer and
 * completed the key agreement against the public key inside it. An answer
 * lifted from another transfer, an answer replayed against a fresh offer, and
 * an answer whose SDP or public key was edited in transit all yield a tag the
 * sender does not expect.
 *
 * It is checked by the machine, not by a human — unlike the PIN Exchange
 * confirmation code (deriveConfirmationCode), nothing is displayed and nothing
 * is typed. Nor does it authenticate *who* answered: the offer is the only
 * secret Code Exchange has, so anyone who captured it can derive this tag too.
 * See ANSWER_CONFIRMATION_BYTES for exactly what it does and does not cover.
 */
export async function deriveAnswerConfirmation(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
  offerTranscriptHash: string,
): Promise<Uint8Array> {
  if (salt.length < SALT_LENGTH) {
    throw new Error(
      `Salt too short: expected at least ${SALT_LENGTH} bytes, got ${salt.length}`,
    );
  }

  const info = `${ANSWER_CONFIRMATION_LABEL}|${offerTranscriptHash}`;
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: new TextEncoder().encode(info),
    },
    sharedSecretKey,
    ANSWER_CONFIRMATION_BYTES * 8,
  );

  return new Uint8Array(bits);
}

/**
 * Generate random salt for key derivation
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return salt;
}
