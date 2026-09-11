import { describe, expect, it } from 'vitest';
import { compressPayload } from './codec';
import { isValidNostrFileManifest, type NostrFileManifest } from './manifest';

describe('isValidNostrFileManifest', () => {
  const createdAt = 1_700_000_000;
  const manifest: NostrFileManifest = {
    v: 7,
    fileName: 'big.bin',
    fileSize: 100 * 1024 * 1024,
    mimeType: 'application/octet-stream',
    fileHash: `${'B'.repeat(43)}=`,
    pubkey: 'c'.repeat(64),
    compression: 'none',
    payloadSize: 100 * 1024 * 1024,
    chunkSize: 32768,
    totalChunks: 3200,
    enc: 2,
    createdAt,
    expiresAt: createdAt + 3600,
  };

  it('accepts a 100 MiB manifest', () => {
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

  it('accepts what the sender actually produces for incompressible input', () => {
    // Random bytes do not compress: the payload is the file plus the framing
    // of every stored block fflate splits it into, which is more blocks than
    // one per 64 KiB.
    const fileSize = 3_000_000;
    const random = new Uint8Array(fileSize);
    for (let offset = 0; offset < fileSize; offset += 65_536) {
      crypto.getRandomValues(
        random.subarray(offset, Math.min(offset + 65_536, fileSize)),
      );
    }
    const { payload } = compressPayload(random, false);
    expect(payload.length).toBeGreaterThan(
      fileSize + Math.ceil(fileSize / 65_535) * 5 + 64,
    );
    expect(
      isValidNostrFileManifest({
        ...manifest,
        fileSize,
        compression: 'deflate',
        payloadSize: payload.length,
        totalChunks: Math.ceil(payload.length / manifest.chunkSize),
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

  it('rejects files over 100 MiB', () => {
    expect(
      isValidNostrFileManifest({
        ...manifest,
        fileSize: 100 * 1024 * 1024 + 1,
        payloadSize: 100 * 1024 * 1024 + 1,
        totalChunks: 3201,
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
