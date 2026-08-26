import type { RendezvousPayload, TransferMetadata } from './types';

/**
 * Frozen transcript vectors, shared by the tests that pin them and the check
 * that docs/INTEROP_PROTOCOL.md publishes them.
 *
 * These are the wire format's known-answer tests. Every other transcript test
 * is relative — reordering the canonical array, dropping a field, or editing a
 * version label would leave them all green — so these are what make such a
 * change a deliberate protocol bump rather than an accident.
 *
 * They live here rather than inside a test file because the spec publishes them
 * for other implementations to check their canonicalization against, and a
 * vector that has quietly drifted from the one this app computes is worse than
 * no vector at all. One definition, checked from both directions.
 */

/** HKDF salt for the rendezvous vector. */
export const VECTOR_SALT = new Uint8Array(32).fill(7);

export const RENDEZVOUS_VECTOR = {
  payload: {
    type: 'rendezvous',
    transferId: 'a1b2c3d4e5f60718',
    senderPubkey: 'a'.repeat(64),
    pakeMessage: 'ApAkEeLeMeNtBase64==',
    nonce: 'c2VuZGVyLW5vbmNlLTAwMDAwMDA=',
    relays: ['wss://relay.one', 'wss://relay.two'],
  } satisfies RendezvousPayload,
  digest: 'edf3c4ce9b70adf0cb6e316e247f2f840e18af094d20466dfd55c00e694be675',
} as const;

export const METADATA_VECTOR = {
  metadata: {
    contentType: 'file',
    fileName: 'quarterly-report.pdf',
    fileSize: 1048576,
    contentEncoding: 'deflate-raw',
    mimeType: 'application/pdf',
  } satisfies TransferMetadata,
  digest: 'd71c5d4c12479dfb7e1e4f7c9fd169cddd73206e8c369d49a98f7b726a025f84',
} as const;
