import { describe, expect, it } from 'vitest';
import { isValidNostrFileManifest, type NostrFileManifest } from './manifest';

describe('isValidNostrFileManifest', () => {
  const createdAt = 1_700_000_000;
  const manifest: NostrFileManifest = {
    v: 7,
    fileName: 'big.bin',
    fileSize: 100 * 1024 * 1024,
    mimeType: 'application/octet-stream',
    fileHash: `${'B'.repeat(43)}=`,
    transferId: 'a'.repeat(32),
    pubkey: 'c'.repeat(64),
    compression: 'none',
    payloadSize: 100 * 1024 * 1024,
    chunkSize: 32768,
    totalChunks: 3200,
    enc: 2,
    controlRelays: ['wss://relay.one', 'wss://relay.two', 'wss://relay.three'],
    createdAt,
    expiresAt: createdAt + 3600,
  };

  it('accepts a 100 MB manifest', () => {
    expect(isValidNostrFileManifest(manifest)).toBe(true);
  });

  it('accepts a deflated payload smaller than the file', () => {
    expect(
      isValidNostrFileManifest({
        ...manifest,
        compression: 'deflate',
        payloadSize: 1024 * 1024,
        totalChunks: 32,
      }),
    ).toBe(true);
  });

  it('accepts a deflated payload slightly larger than the file (incompressible input)', () => {
    // Single-file payloads always deflate; raw deflate adds stored-block
    // framing when the input does not shrink.
    expect(
      isValidNostrFileManifest({
        ...manifest,
        compression: 'deflate',
        payloadSize: manifest.fileSize + 10,
        totalChunks: Math.ceil((manifest.fileSize + 10) / manifest.chunkSize),
      }),
    ).toBe(true);
  });

  it('rejects inconsistent compression fields', () => {
    // Unknown scheme.
    expect(isValidNostrFileManifest({ ...manifest, compression: 'gzip' })).toBe(
      false,
    );
    // 'none' must chunk exactly the file bytes.
    expect(
      isValidNostrFileManifest({
        ...manifest,
        payloadSize: manifest.fileSize - 1,
      }),
    ).toBe(false);
    // 'deflate' output is bounded by raw deflate's worst-case expansion.
    expect(
      isValidNostrFileManifest({
        ...manifest,
        compression: 'deflate',
        payloadSize: manifest.fileSize * 2,
        totalChunks: Math.ceil((manifest.fileSize * 2) / manifest.chunkSize),
      }),
    ).toBe(false);
    // Chunk count must cover the payload, not the plaintext.
    expect(
      isValidNostrFileManifest({
        ...manifest,
        compression: 'deflate',
        payloadSize: 1024 * 1024,
      }),
    ).toBe(false);
  });

  it('rejects control-relay lists outside 2..6 and files over 100 MB', () => {
    expect(
      isValidNostrFileManifest({
        ...manifest,
        controlRelays: Array.from(
          { length: 6 },
          (_, i) => `wss://r${i}.example`,
        ),
      }),
    ).toBe(true);
    expect(
      isValidNostrFileManifest({
        ...manifest,
        controlRelays: Array.from(
          { length: 7 },
          (_, i) => `wss://r${i}.example`,
        ),
      }),
    ).toBe(false);
    expect(
      isValidNostrFileManifest({
        ...manifest,
        controlRelays: ['wss://relay.one'],
      }),
    ).toBe(false);
    expect(
      isValidNostrFileManifest({
        ...manifest,
        fileSize: 100 * 1024 * 1024 + 1,
        payloadSize: 100 * 1024 * 1024 + 1,
        totalChunks: 3201,
      }),
    ).toBe(false);
  });

  it('rejects duplicate control relays, equivalent URL forms included', () => {
    expect(
      isValidNostrFileManifest({
        ...manifest,
        controlRelays: ['wss://relay.one', 'wss://relay.one'],
      }),
    ).toBe(false);
    expect(
      isValidNostrFileManifest({
        ...manifest,
        controlRelays: ['wss://relay.one', 'wss://relay.one/'],
      }),
    ).toBe(false);
  });

  it('rejects noncanonical control relay URLs', () => {
    expect(
      isValidNostrFileManifest({
        ...manifest,
        controlRelays: [
          'wss://relay.one/',
          'wss://relay.two',
          'wss://relay.three',
        ],
      }),
    ).toBe(false);
  });

  it('rejects the previous wire format', () => {
    expect(isValidNostrFileManifest({ ...manifest, v: 6 })).toBe(false);
    expect(isValidNostrFileManifest({ ...manifest, enc: 1 })).toBe(false);
    const { compression, payloadSize, ...perChunkDeflate } = manifest;
    expect(isValidNostrFileManifest(perChunkDeflate)).toBe(false);
  });
});
