import {
  type Event,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { PIN_ACTIVE_BUCKETS, PIN_ROTATION_MS } from '../crypto/constants';
import { EVENT_KIND_DATA_TRANSFER, EVENT_KIND_RENDEZVOUS } from './types';

/**
 * Generate ephemeral keypair for a transfer
 */
export function generateEphemeralKeys(): {
  secretKey: Uint8Array;
  publicKey: string;
} {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey };
}

/**
 * Generate a random handshake nonce (16 bytes, base64).
 * The sender mints one per rendezvous publication; the receiver mints one per
 * claim. Echoing them inside the sealed claim/confirm payloads prevents replay
 * across rotations, transfers, and handshake directions.
 */
export function generateHandshakeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return uint8ArrayToBase64(bytes);
}

/**
 * Create rendezvous event (kind 24243).
 * Contains the payload encrypted with the PIN-derived rendezvous key.
 *
 * @param hint - Rotation-bucket-scoped event-filtering tag: an HKDF derivation
 * off the PIN's public locator segment (see computePinHintFromLocator). It is a
 * filter, not an identifier — unrelated transfers in the same bucket collide,
 * and the receiver disambiguates by decrypting candidates.
 *
 * TTL behavior:
 * - The 'expiration' tag is the end of the PIN's immediately following bucket
 *   (NIP-40), matching the sender's current-or-previous acceptance rule
 * - The sender stops publishing (and stops honoring retained PIN generations)
 *   once a claim is verified
 * - The receiver refuses rendezvous events older than PIN_TTL_MS
 */
export function createRendezvousEvent(
  secretKey: Uint8Array,
  encryptedPayload: Uint8Array,
  salt: Uint8Array,
  transferId: string,
  hint: string,
  pinBucket: number,
): Event {
  // Soft TTL: relays may auto-delete after this timestamp (NIP-40)
  const expiration = Math.floor(
    ((pinBucket + PIN_ACTIVE_BUCKETS) * PIN_ROTATION_MS) / 1000,
  );

  const event = finalizeEvent(
    {
      kind: EVENT_KIND_RENDEZVOUS,
      content: uint8ArrayToBase64(encryptedPayload),
      tags: [
        ['h', hint],
        ['s', uint8ArrayToBase64(salt)],
        ['t', transferId],
        ['type', 'rendezvous'],
        ['expiration', expiration.toString()],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey,
  );

  return event;
}

/**
 * Parse rendezvous event tags.
 * @returns Object with hint, salt, transferId, and encryptedPayload
 */
export function parseRendezvousEvent(event: Event): {
  hint: string;
  salt: Uint8Array;
  transferId: string;
  encryptedPayload: Uint8Array;
} | null {
  if (event.kind !== EVENT_KIND_RENDEZVOUS) return null;

  const hint = event.tags.find((t) => t[0] === 'h')?.[1];
  const saltB64 = event.tags.find((t) => t[0] === 's')?.[1];
  const transferId = event.tags.find((t) => t[0] === 't')?.[1];

  if (!hint || !saltB64 || !transferId) return null;

  try {
    return {
      hint,
      salt: base64ToUint8Array(saltB64),
      transferId,
      encryptedPayload: base64ToUint8Array(event.content),
    };
  } catch {
    return null;
  }
}

export type HandshakeType = 'claim' | 'confirm';

/**
 * Create a handshake event (kind 24242, type=claim|confirm).
 *
 * Tags stay plaintext so relays can route by transfer and recipient, but they
 * carry no authority: the sealed body must decrypt under the PIN-derived auth
 * key and repeat the transfer/nonces before either side acts on it.
 */
export function createHandshakeEvent(
  secretKey: Uint8Array,
  recipientPubkey: string,
  transferId: string,
  type: HandshakeType,
  sealedPayload: Uint8Array,
): Event {
  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content: uint8ArrayToBase64(sealedPayload),
      tags: [
        ['p', recipientPubkey],
        ['t', transferId],
        ['type', type],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey,
  );

  return event;
}

/**
 * Parse a handshake event (claim or confirm).
 */
export function parseHandshakeEvent(event: Event): {
  recipientPubkey: string;
  transferId: string;
  type: HandshakeType;
  sealedPayload: Uint8Array;
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null;

  const type = event.tags.find((t) => t[0] === 'type')?.[1];
  if (type !== 'claim' && type !== 'confirm') return null;

  const recipientPubkey = event.tags.find((t) => t[0] === 'p')?.[1];
  const transferId = event.tags.find((t) => t[0] === 't')?.[1];

  if (!recipientPubkey || !transferId || !event.content) return null;

  try {
    return {
      recipientPubkey,
      transferId,
      type,
      sealedPayload: base64ToUint8Array(event.content),
    };
  } catch {
    return null;
  }
}

/**
 * Seal a handshake payload (claim/confirm) with the PIN-derived auth key.
 * AES-GCM's authentication tag is what makes a wrong-PIN proof unverifiable.
 */
export async function sealHandshakePayload(
  authKey: CryptoKey,
  payload: object,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return encrypt(authKey, bytes);
}

/**
 * Open a sealed handshake payload. Throws if the payload was not sealed with
 * this auth key (i.e. the author used a different PIN) or is not valid JSON.
 * Field validation is the caller's job.
 */
export async function openHandshakePayload(
  authKey: CryptoKey,
  sealedPayload: Uint8Array,
): Promise<unknown> {
  const decrypted = await decrypt(authKey, sealedPayload);
  return JSON.parse(new TextDecoder().decode(decrypted)) as unknown;
}

/**
 * Create Signaling event (kind 24242 with type=signal)
 */
export function createSignalingEvent(
  secretKey: Uint8Array,
  senderPubkey: string,
  transferId: string,
  encryptedSignal: Uint8Array,
): Event {
  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content: uint8ArrayToBase64(encryptedSignal),
      tags: [
        ['t', transferId],
        ['p', senderPubkey],
        ['type', 'signal'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey,
  );
  return event;
}

/**
 * Parse Signaling event
 */
export function parseSignalingEvent(event: Event): {
  transferId: string;
  senderPubkey: string;
  encryptedSignal: Uint8Array;
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null;

  const type = event.tags.find((t) => t[0] === 'type')?.[1];
  if (type !== 'signal') return null;

  const transferId = event.tags.find((t) => t[0] === 't')?.[1];
  const senderPubkey = event.tags.find((t) => t[0] === 'p')?.[1];

  if (!transferId || !senderPubkey) return null;

  try {
    const encryptedSignal = base64ToUint8Array(event.content);
    return { transferId, senderPubkey, encryptedSignal };
  } catch {
    return null;
  }
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
