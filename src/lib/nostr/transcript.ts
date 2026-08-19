import type { RendezvousPayload, TransferMetadata } from './types';

/**
 * Versioned domain separators. Bump them with any change to the field lists
 * below, so a transcript from an older protocol can never hash equal to a
 * newer one.
 */
const TRANSCRIPT_LABEL = 'secure-send:nostr-rendezvous-transcript:v4';
const METADATA_LABEL = 'secure-send:nostr-metadata-transcript:v1';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * Hash everything the rendezvous published in plaintext, so both peers can
 * check they acted on the same one.
 *
 * The SPAKE2 transcript already keys the session by both identities, both
 * elements, and the transfer id — a substituted element or a rewrapped
 * identity yields a different root key and every seal fails on its own. What
 * it does not cover is the rest of the rendezvous record: the salt (an HKDF
 * input for every session key) and the relay hints. This digest extends the
 * agreement to those, and to the exact wire encoding of the fields the PAKE
 * covers only semantically.
 *
 * It is folded into the sealed claim and confirm (so a mismatch is rejected
 * automatically) and into the confirmation-code KDF (so even a missed check
 * would surface as two humans reading different codes).
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
    payload.transferId,
    payload.senderPubkey,
    payload.pakeMessage,
    payload.nonce,
    payload.relays ?? [],
    toHex(salt),
  ]);

  return sha256Hex(canonical);
}

/**
 * Hash the file metadata the sender delivers inside its sealed confirm.
 *
 * Metadata moved out of the rendezvous (nothing PIN-guessable may be
 * published, and nothing published is encrypted anymore), so it can no longer
 * ride the rendezvous transcript — the receiver commits to that digest in its
 * claim, before it has seen any metadata. This separate digest is bound into
 * the confirmation-code KDF instead: the AES-GCM seal on the confirm already
 * authenticates the metadata cryptographically, and this makes the code the
 * humans compare attest to *what* is being transferred as well.
 */
export async function computeTransferMetadataHash(
  metadata: TransferMetadata,
): Promise<string> {
  const canonical = JSON.stringify([
    METADATA_LABEL,
    metadata.contentType,
    metadata.fileName,
    metadata.fileSize,
    metadata.fileSizeExact,
    metadata.mimeType,
  ]);

  return sha256Hex(canonical);
}
