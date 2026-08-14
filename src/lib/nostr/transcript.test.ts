import { describe, expect, it } from 'vitest';
import { computeRendezvousTranscriptHash } from './transcript';
import type { RendezvousPayload } from './types';

const SALT = new Uint8Array(32).fill(7);

const payload: RendezvousPayload = {
  type: 'rendezvous',
  contentType: 'file',
  transferId: 'a1b2c3d4e5f60718',
  senderPubkey: 'a'.repeat(64),
  ecdhPublicKey: 'BApublicKeyBase64==',
  nonce: 'c2VuZGVyLW5vbmNlLTAwMDAwMDA=',
  relays: ['wss://relay.one', 'wss://relay.two'],
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
  });

  it('changes when any covered field changes', async () => {
    const base = await computeRendezvousTranscriptHash(payload, SALT);

    // contentType is not varied: ContentType is currently the single value
    // 'file', so there is nothing to substitute. It stays in the digest so
    // widening the union later is covered without touching this hash.
    const variants: RendezvousPayload[] = [
      { ...payload, transferId: '0000000000000000' },
      { ...payload, senderPubkey: 'b'.repeat(64) },
      { ...payload, ecdhPublicKey: 'BAotherKeyBase64==' },
      { ...payload, nonce: 'b3RoZXItc2VuZGVyLW5vbmNlLTA=' },
      { ...payload, relays: ['wss://relay.one'] },
      { ...payload, fileName: 'quarterly-report.exe' },
      { ...payload, fileSize: 1048577 },
      { ...payload, fileSizeExact: false },
      { ...payload, mimeType: 'text/html' },
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
      { ...payload, fileName: 'report', mimeType: 'application/pdf' },
      SALT,
    );
    const b = await computeRendezvousTranscriptHash(
      { ...payload, fileName: 'report","application/pdf', mimeType: '' },
      SALT,
    );

    expect(a).not.toBe(b);
  });
});
