import { RELAY_SESSION_INFO } from './constants';

/**
 * The relay-fallback session that both sides of a Code Exchange share.
 *
 * Nothing about it travels in a code: once the offer/answer exchange has
 * produced the ECDH shared secret, sender and receiver each run HKDF over
 * it with a fallback-specific label and arrive at the same transfer
 * identifier (the public `d`/`x` tag namespace on relays) and the same raw
 * 32-byte file key (which keys the chunks and, via `deriveControlKey`, the
 * encrypted control channel). The control relays are the proven relays the
 * offer already named, so the session is ready the moment signaling
 * completes — and costs nothing until a direct connection
 * actually fails and the file has to go through relays.
 */
export interface RelaySession {
  /** 32 hex chars — d/x tag namespace on relays */
  transferId: string;
  /** Raw AES-256-GCM file key. Owned by the engine that consumes it, which wipes it. */
  keyBytes: Uint8Array;
}

const TRANSFER_ID_BYTES = 16;
const FILE_KEY_BYTES = 32;

export async function deriveRelaySession(
  sharedSecretKey: CryptoKey,
  salt: Uint8Array,
): Promise<RelaySession> {
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as BufferSource,
        info: new TextEncoder().encode(RELAY_SESSION_INFO),
      },
      sharedSecretKey,
      (TRANSFER_ID_BYTES + FILE_KEY_BYTES) * 8,
    ),
  );
  const transferId = Array.from(bits.subarray(0, TRANSFER_ID_BYTES), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const keyBytes = bits.slice(TRANSFER_ID_BYTES);
  bits.fill(0);
  return { transferId, keyBytes };
}
