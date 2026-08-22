import { describe, expect, it } from 'vitest';
import { isValidNostrFileManifest, type NostrFileManifest } from './manifest';

describe('isValidNostrFileManifest', () => {
  const createdAt = 1_700_000_000;
  const manifest: NostrFileManifest = {
    v: 3,
    fileName: 'big.bin',
    fileSize: 100 * 1024 * 1024,
    mimeType: 'application/octet-stream',
    fileHash: `${'B'.repeat(43)}=`,
    transferId: 'a'.repeat(32),
    pubkey: 'c'.repeat(64),
    chunkSize: 32768,
    totalChunks: 3200,
    enc: 1,
    relays: ['wss://relay.one', 'wss://relay.two', 'wss://relay.three'],
    createdAt,
    expiresAt: createdAt + 3600,
  };

  it('accepts a 100 MB manifest', () => {
    expect(isValidNostrFileManifest(manifest)).toBe(true);
  });

  it('rejects more than 16 relays and files over 100 MB', () => {
    expect(
      isValidNostrFileManifest({
        ...manifest,
        relays: Array.from({ length: 17 }, (_, i) => `wss://r${i}.example`),
      }),
    ).toBe(false);
    expect(
      isValidNostrFileManifest({
        ...manifest,
        fileSize: 100 * 1024 * 1024 + 1,
        totalChunks: 3201,
      }),
    ).toBe(false);
  });
});
