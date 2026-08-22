import { describe, expect, it } from 'vitest';
import { isValidNostrFileManifest, type NostrFileManifest } from './manifest';

describe('isValidNostrFileManifest', () => {
  const createdAt = 1_700_000_000;
  const manifest: NostrFileManifest = {
    v: 4,
    fileName: 'big.bin',
    fileSize: 100 * 1024 * 1024,
    mimeType: 'application/octet-stream',
    fileHash: `${'B'.repeat(43)}=`,
    transferId: 'a'.repeat(32),
    pubkey: 'c'.repeat(64),
    chunkSize: 32768,
    totalChunks: 3200,
    enc: 1,
    controlRelays: ['wss://relay.one', 'wss://relay.two', 'wss://relay.three'],
    createdAt,
    expiresAt: createdAt + 3600,
  };

  it('accepts a 100 MB manifest', () => {
    expect(isValidNostrFileManifest(manifest)).toBe(true);
  });

  it('rejects control-relay lists outside 2..4 and files over 100 MB', () => {
    expect(
      isValidNostrFileManifest({
        ...manifest,
        controlRelays: Array.from(
          { length: 5 },
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

  it('rejects the previous wire format', () => {
    expect(isValidNostrFileManifest({ ...manifest, v: 3 })).toBe(false);
    const { controlRelays, ...rest } = manifest;
    expect(isValidNostrFileManifest({ ...rest, relays: controlRelays })).toBe(
      false,
    );
  });
});
