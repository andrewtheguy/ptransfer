import type { RendezvousPayload } from './types';

/**
 * Versioned domain separator. Bump it with any change to the field list below,
 * so a transcript from an older protocol can never hash equal to a newer one.
 */
const TRANSCRIPT_LABEL = 'secure-send:nostr-rendezvous-transcript:v1';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash everything the two peers must agree on about *what* is being
 * transferred, before either of them commits to it.
 *
 * The confirmation code is keyed by the ECDH shared secret, so it proves no
 * one substituted an ECDH key. It does not, by itself, prove anything about the
 * rest of the rendezvous: an attacker holding a live PIN can republish the
 * rendezvous under its own Nostr identity, pass both ECDH keys through
 * untouched, and swap the file metadata. Both sides then derive the *same*
 * code, the humans compare successfully, and the receiver saves genuine bytes
 * under an attacker-chosen name and MIME type.
 *
 * Folding this digest into the claim, the confirm, and the confirmation-code
 * KDF closes that: the receiver hashes the rendezvous it acted on, the sender
 * hashes the one it published, and any difference — one byte of file name, a
 * substituted sender identity, a replayed nonce, a different salt — makes the
 * claim fail verification and the two codes disagree.
 *
 * Canonicalization is a JSON array rather than an object: element order is
 * fixed here instead of depending on key ordering, and JSON string escaping
 * means no field value can forge a delimiter into another field.
 */
export async function computeRendezvousTranscriptHash(
  payload: RendezvousPayload,
  salt: Uint8Array,
): Promise<string> {
  const canonical = JSON.stringify([
    TRANSCRIPT_LABEL,
    payload.type,
    payload.contentType,
    payload.transferId,
    payload.senderPubkey,
    payload.ecdhPublicKey,
    payload.nonce,
    payload.relays ?? [],
    payload.fileName,
    payload.fileSize,
    payload.fileSizeExact,
    payload.mimeType,
    toHex(salt),
  ]);

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );

  return toHex(new Uint8Array(digest));
}
