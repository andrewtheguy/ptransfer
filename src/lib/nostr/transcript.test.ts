import { describe, expect, it } from 'vitest';
import {
  computeRendezvousTranscriptHash,
  computeTransferMetadataHash,
} from './transcript';
import {
  METADATA_VECTOR,
  RENDEZVOUS_VECTOR,
  VECTOR_SALT,
} from './transcript-vectors';
import type { RendezvousPayload, TransferMetadata } from './types';

// The frozen vectors live in transcript-vectors.ts because the interop spec
// publishes them too; see the note there.
const SALT = VECTOR_SALT;
const payload: RendezvousPayload = RENDEZVOUS_VECTOR.payload;
const metadata: TransferMetadata = METADATA_VECTOR.metadata;

describe('Rendezvous transcript hash', () => {
  it('is a deterministic SHA-256 hex digest', async () => {
    const hash = await computeRendezvousTranscriptHash(payload, SALT);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeRendezvousTranscriptHash(payload, SALT)).toBe(hash);

    // Frozen pTransfer v4 vector; see transcript-vectors.ts for why it is
    // pinned and why it lives outside this file.
    expect(hash).toBe(RENDEZVOUS_VECTOR.digest);
  });

  it('changes when any covered field changes', async () => {
    const base = await computeRendezvousTranscriptHash(payload, SALT);

    const variants: RendezvousPayload[] = [
      { ...payload, transferId: '0000000000000000' },
      { ...payload, senderPubkey: 'b'.repeat(64) },
      { ...payload, pakeMessage: 'AotherElementBase64=' },
      { ...payload, nonce: 'b3RoZXItc2VuZGVyLW5vbmNlLTA=' },
      { ...payload, relays: ['wss://relay.one'] },
    ];

    for (const variant of variants) {
      expect(await computeRendezvousTranscriptHash(variant, SALT)).not.toBe(
        base,
      );
    }

    // The salt is not in the payload but is part of the agreed transcript.
    expect(
      await computeRendezvousTranscriptHash(
        payload,
        new Uint8Array(32).fill(8),
      ),
    ).not.toBe(base);
  });

  it('cannot be forged by shifting text across field boundaries', async () => {
    // JSON escaping is what makes the canonical form injective: moving a
    // separator-looking substring from one field into the next must not
    // produce the same digest.
    const a = await computeRendezvousTranscriptHash(
      { ...payload, pakeMessage: 'element', nonce: 'nonce' },
      SALT,
    );
    const b = await computeRendezvousTranscriptHash(
      { ...payload, pakeMessage: 'element","nonce', nonce: '' },
      SALT,
    );

    expect(a).not.toBe(b);
  });
});

describe('Transfer metadata hash', () => {
  it('is a deterministic SHA-256 hex digest with a frozen vector', async () => {
    const hash = await computeTransferMetadataHash(metadata);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeTransferMetadataHash(metadata)).toBe(hash);

    // Frozen pTransfer v2 vector, for the same reason as the rendezvous vector above.
    expect(hash).toBe(METADATA_VECTOR.digest);
  });

  it('changes when any covered field changes', async () => {
    const base = await computeTransferMetadataHash(metadata);

    // contentType is not varied: ContentType is currently the single value
    // 'file', so there is nothing to substitute. It stays in the digest so
    // widening the union later is covered without touching this hash.
    const variants: TransferMetadata[] = [
      { ...metadata, fileName: 'quarterly-report.exe' },
      { ...metadata, fileSize: 1048577 },
      { ...metadata, contentEncoding: 'identity' },
      { ...metadata, mimeType: 'text/html' },
    ];

    for (const variant of variants) {
      expect(await computeTransferMetadataHash(variant)).not.toBe(base);
    }
  });

  it('cannot be forged by shifting text across field boundaries', async () => {
    const a = await computeTransferMetadataHash({
      ...metadata,
      fileName: 'report',
      mimeType: 'application/pdf',
    });
    const b = await computeTransferMetadataHash({
      ...metadata,
      fileName: 'report","application/pdf',
      mimeType: '',
    });

    expect(a).not.toBe(b);
  });
});
