import { describe, expect, it } from 'vitest';
import {
  computeRendezvousTranscriptHash,
  computeTransferMetadataHash,
} from './transcript';
import type { RendezvousPayload, TransferMetadata } from './types';

const SALT = new Uint8Array(32).fill(7);

const payload: RendezvousPayload = {
  type: 'rendezvous',
  transferId: 'a1b2c3d4e5f60718',
  senderPubkey: 'a'.repeat(64),
  pakeMessage: 'ApAkEeLeMeNtBase64==',
  nonce: 'c2VuZGVyLW5vbmNlLTAwMDAwMDA=',
  relays: ['wss://relay.one', 'wss://relay.two'],
};

const metadata: TransferMetadata = {
  contentType: 'file',
  fileName: 'quarterly-report.pdf',
  fileSize: 1048576,
  fileSizeExact: true,
  mimeType: 'application/pdf',
};

describe('Rendezvous transcript hash', () => {
  it('is a deterministic SHA-256 hex digest', async () => {
    const hash = await computeRendezvousTranscriptHash(payload, SALT);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeRendezvousTranscriptHash(payload, SALT)).toBe(hash);

    // Frozen v3 vector. Every other test here is relative — reordering the
    // canonical array, dropping a field, or editing the version label would
    // leave them all green. This pins the wire format itself, so any such
    // change has to be a deliberate protocol bump rather than an accident.
    expect(hash).toBe(
      '614d33304b183901aa0a9dae42add9b0b8b843b76b3b22f1f1e890a0d08e7643',
    );
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

    // Frozen v1 vector, for the same reason as the rendezvous vector above.
    expect(hash).toBe(
      '4e81dd4145657c1786a5a7109907cc70b1492cd17a8dcf1cfeeccf81c92aee26',
    );
  });

  it('changes when any covered field changes', async () => {
    const base = await computeTransferMetadataHash(metadata);

    // contentType is not varied: ContentType is currently the single value
    // 'file', so there is nothing to substitute. It stays in the digest so
    // widening the union later is covered without touching this hash.
    const variants: TransferMetadata[] = [
      { ...metadata, fileName: 'quarterly-report.exe' },
      { ...metadata, fileSize: 1048577 },
      { ...metadata, fileSizeExact: false },
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
