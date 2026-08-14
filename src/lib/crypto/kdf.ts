import { encodeCrockfordBase32 } from './base32';
import {
  AES_KEY_LENGTH,
  CONFIRMATION_CODE_BYTES,
  SALT_LENGTH,
} from './constants';

/**
 * Session keys for Auto Exchange (Nostr) mode, derived from the ephemeral ECDH
 * shared secret established during the PIN-authenticated handshake. The PIN
 * itself derives none of these — see importPinRoot in pin.ts.
 */
export interface NostrSessionKeys {
  /** Encrypts relay-carried WebRTC signaling (offer/answer/candidates). */
  signals: CryptoKey;
  /** Encrypts P2P file content chunks on the data channel. */
  content: CryptoKey;
}

const SESSION_KEY_LABELS = {
  signals: 'secure-send:nostr-session:v2:signals',
  content: 'secure-send:nostr-session:v2:content',
} as const satisfies Record<keyof NostrSessionKeys, string>;

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
 * Derive the Auto Exchange session keys from the non-extractable HKDF key
 * returned by deriveSharedSecretKey (ecdh.ts) and the public per-transfer salt.
 * Distinct HKDF info labels guarantee signaling and content never reuse the
 * same AES-GCM key.
 */
export async function deriveNostrSessionKeys(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
): Promise<NostrSessionKeys> {
  const [signals, content] = await Promise.all([
    deriveSessionKey(sharedSecretKey, salt, SESSION_KEY_LABELS.signals),
    deriveSessionKey(sharedSecretKey, salt, SESSION_KEY_LABELS.content),
  ]);

  return { signals, content };
}

const CONFIRMATION_CODE_LABEL = 'secure-send:nostr-session:v2:confirmation';

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
   * identity, ECDH key, salt, and all file metadata (see nostr/transcript.ts).
   * Without it the code proves only that no ECDH key was substituted, which is
   * exactly the attack that leaves both keys alone and rewrites the metadata.
   */
  transcriptHash: string;
}

/**
 * Derive the confirmation code both peers show to their humans: a short
 * authentication string over the ephemeral ECDH shared secret.
 *
 * The receiver computes it as soon as it has opened the rendezvous payload —
 * which already proves it knew the PIN — and displays it. The sender computes
 * the same value from the claim it locked onto and refuses to publish its
 * confirm, or any WebRTC signaling, until its operator types a code that
 * matches. Since the code is keyed by the shared secret, only the peer holding
 * the matching ECDH private key can produce it, so someone who front-ran the
 * intended receiver with a stolen PIN wins the claim race and then has nothing
 * to say when the sender asks for the code.
 *
 * The same property makes it a key-confirmation check: a relay that substituted
 * either ECDH public key would produce a different shared secret, hence a
 * different code on each side.
 *
 * Binding in the transfer id and both nonces stops a code captured from one
 * rotation, transfer, or direction from being replayed into another. Binding in
 * the rendezvous transcript extends the guarantee past the ECDH keys to *what*
 * is being transferred and *who* published it, which a shared secret alone
 * says nothing about.
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

  // transferId and transcriptHash are hex and both nonces are fixed-length
  // base64, so '|' cannot appear inside a field and the join is unambiguous.
  const info = [
    CONFIRMATION_CODE_LABEL,
    binding.transferId,
    binding.senderNonce,
    binding.receiverNonce,
    binding.transcriptHash,
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

/**
 * Generate random salt for key derivation
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return salt;
}
