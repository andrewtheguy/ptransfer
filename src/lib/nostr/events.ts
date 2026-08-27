import {
  type Event,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../base64';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { PIN_ACTIVE_BUCKETS, PIN_ROTATION_MS } from '../crypto/constants';
import {
  EVENT_KIND_DATA_TRANSFER,
  EVENT_KIND_RENDEZVOUS,
  type RendezvousPayload,
} from './types';

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
 * Create rendezvous event (regular kind 4243).
 * The payload is plaintext JSON: with SPAKE2 nothing in it is sensitive (the
 * element is password-blinded, the nonce and relay hints carry no authority),
 * and encrypting it under a PIN-derived key would reintroduce the offline
 * guessing target the PAKE removes. File metadata is deliberately absent — it
 * travels sealed inside the confirm, after the handshake.
 *
 * @param hint - Rotation-bucket-scoped event-filtering tag: an HKDF derivation
 * off the PIN's public locator segment (see computePinHintFromLocator). It is a
 * filter, not an identifier — unrelated transfers in the same bucket collide,
 * and the receiver claims several candidates to disambiguate.
 *
 * TTL behavior:
 * - The 'expiration' tag is the end of the PIN's immediately following bucket
 *   (NIP-40), matching the sender's current-or-previous acceptance rule
 * - The sender stops publishing (and stops honoring retained PIN generations)
 *   once a claim is verified
 * - The receiver refuses rendezvous events whose created_at did not land in
 *   one of the buckets it derived hints for (the same acceptance rule)
 */
export function createRendezvousEvent(
  secretKey: Uint8Array,
  payload: RendezvousPayload,
  salt: Uint8Array,
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
      content: JSON.stringify(payload),
      tags: [
        ['h', hint],
        ['s', uint8ArrayToBase64(salt)],
        ['t', payload.transferId],
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
 * Parse a rendezvous event: tags plus the plaintext JSON payload. Only shape
 * is checked here; field validation (author binding, element validity,
 * freshness) is the caller's job.
 */
export function parseRendezvousEvent(event: Event): {
  hint: string;
  salt: Uint8Array;
  transferId: string;
  payload: unknown;
} | null {
  if (event.kind !== EVENT_KIND_RENDEZVOUS) return null;

  const hint = event.tags.find((t) => t[0] === 'h')?.[1];
  const saltB64 = event.tags.find((t) => t[0] === 's')?.[1];
  const transferId = event.tags.find((t) => t[0] === 't')?.[1];

  if (!hint || !saltB64 || !transferId || !event.content) return null;

  try {
    const payload = JSON.parse(event.content) as unknown;
    // Shape floor: the payload must at least be a plain object, or the
    // caller's field validation has nothing to index into.
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return null;
    }
    return {
      hint,
      salt: base64ToUint8Array(saltB64),
      transferId,
      payload,
    };
  } catch {
    return null;
  }
}

export type HandshakeType = 'claim' | 'confirm';

/**
 * Create a handshake event (ephemeral kind 24243, type=claim|confirm).
 *
 * The content is a JSON envelope: the sealed body, plus — for claims — the
 * receiver's SPAKE2 element in plaintext, since the sender must finish its
 * side of the PAKE before it can derive the key that opens the seal, and the
 * plaintext transcript hash of the rendezvous being claimed (`target`), since
 * the sender's elements are single-use and it must know which one a claim
 * spends before doing any curve work. Tags stay plaintext so relays can route
 * by transfer and recipient, but neither they, the element, nor the target
 * carry authority: the sealed body must decrypt under the session's seal key
 * and repeat the transfer/nonces/transcript hash before either side acts on
 * it — the target only routes, and it is a hash of already-public rendezvous
 * data.
 */
export function createHandshakeEvent(
  secretKey: Uint8Array,
  recipientPubkey: string,
  transferId: string,
  type: HandshakeType,
  sealedPayload: Uint8Array,
  pakeMessage?: Uint8Array,
  target?: string,
): Event {
  const envelope: { sealed: string; pake?: string; target?: string } = {
    sealed: uint8ArrayToBase64(sealedPayload),
  };
  if (pakeMessage) {
    envelope.pake = uint8ArrayToBase64(pakeMessage);
  }
  if (target) {
    envelope.target = target;
  }

  const event = finalizeEvent(
    {
      kind: EVENT_KIND_DATA_TRANSFER,
      content: JSON.stringify(envelope),
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
  /** The claimant's SPAKE2 element, when the envelope carries one. */
  pakeMessage: Uint8Array | null;
  /** Transcript hash of the rendezvous a claim targets, when carried. */
  target: string | null;
} | null {
  if (event.kind !== EVENT_KIND_DATA_TRANSFER) return null;

  const type = event.tags.find((t) => t[0] === 'type')?.[1];
  if (type !== 'claim' && type !== 'confirm') return null;

  const recipientPubkey = event.tags.find((t) => t[0] === 'p')?.[1];
  const transferId = event.tags.find((t) => t[0] === 't')?.[1];

  if (!recipientPubkey || !transferId || !event.content) return null;

  try {
    const envelope = JSON.parse(event.content) as {
      sealed?: unknown;
      pake?: unknown;
      target?: unknown;
    };
    if (typeof envelope.sealed !== 'string') return null;
    if (envelope.pake !== undefined && typeof envelope.pake !== 'string') {
      return null;
    }
    if (envelope.target !== undefined && typeof envelope.target !== 'string') {
      return null;
    }
    return {
      recipientPubkey,
      transferId,
      type,
      sealedPayload: base64ToUint8Array(envelope.sealed),
      pakeMessage:
        typeof envelope.pake === 'string'
          ? base64ToUint8Array(envelope.pake)
          : null,
      target: typeof envelope.target === 'string' ? envelope.target : null,
    };
  } catch {
    return null;
  }
}

/**
 * Seal a handshake payload (claim/confirm) with the session's seal key, an
 * HKDF derivation off the SPAKE2 root (see deriveHandshakeSealKeys). AES-GCM's
 * authentication tag is the PAKE's key-confirmation step: only a peer that
 * ran the same session — same PIN, elements, identities, and transfer — can
 * produce or verify it.
 */
export async function sealHandshakePayload(
  sealKey: CryptoKey,
  payload: object,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return encrypt(sealKey, bytes);
}

/**
 * Open a sealed handshake payload. Throws if the payload was not sealed with
 * this session's key (i.e. the author ran a different PAKE session — wrong
 * PIN, wrong generation, or tampered elements) or is not valid JSON. Field
 * validation is the caller's job.
 */
export async function openHandshakePayload(
  sealKey: CryptoKey,
  sealedPayload: Uint8Array,
): Promise<unknown> {
  const decrypted = await decrypt(sealKey, sealedPayload);
  return JSON.parse(new TextDecoder().decode(decrypted)) as unknown;
}

/**
 * Create Signaling event (ephemeral kind 24243 with type=signal)
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

// The Nostr barrel is where the rest of the app has always reached for these.
export { base64ToUint8Array, uint8ArrayToBase64 };
