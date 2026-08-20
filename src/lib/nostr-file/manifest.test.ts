import { describe, expect, it } from 'vitest';
import {
  isValidNostrFileManifest,
  type NostrFileManifest,
  stripeRelays,
} from './manifest';

describe('stripeRelays', () => {
  const relays = ['wss://a', 'wss://b', 'wss://c', 'wss://d'];

  it('places consecutive chunks on consecutive ring positions', () => {
    expect(stripeRelays(relays, 2, 0)).toEqual(['wss://a', 'wss://b']);
    expect(stripeRelays(relays, 2, 1)).toEqual(['wss://b', 'wss://c']);
    expect(stripeRelays(relays, 2, 3)).toEqual(['wss://d', 'wss://a']);
    expect(stripeRelays(relays, 2, 4)).toEqual(['wss://a', 'wss://b']);
  });

  it('spreads load evenly: each relay holds replication/N of the chunks', () => {
    const perRelay = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      for (const r of stripeRelays(relays, 2, i)) {
        perRelay.set(r, (perRelay.get(r) ?? 0) + 1);
      }
    }
    for (const r of relays) expect(perRelay.get(r)).toBe(200);
  });

  it('caps copies at the relay count without duplicates', () => {
    expect(stripeRelays(relays.slice(0, 1), 2, 5)).toEqual(['wss://a']);
    expect(stripeRelays(relays, 9, 2)).toEqual([
      'wss://c',
      'wss://d',
      'wss://a',
      'wss://b',
    ]);
  });
});

describe('isValidNostrFileManifest replication', () => {
  const createdAt = 1_700_000_000;
  const manifest: NostrFileManifest = {
    v: 2,
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
    replication: 2,
    createdAt,
    expiresAt: createdAt + 3600,
  };

  it('accepts a 100 MB striped manifest', () => {
    expect(isValidNostrFileManifest(manifest)).toBe(true);
  });

  it('bounds replication to [1, relays.length]', () => {
    expect(isValidNostrFileManifest({ ...manifest, replication: 0 })).toBe(
      false,
    );
    expect(isValidNostrFileManifest({ ...manifest, replication: 4 })).toBe(
      false,
    );
    expect(isValidNostrFileManifest({ ...manifest, replication: 1.5 })).toBe(
      false,
    );
    expect(isValidNostrFileManifest({ ...manifest, replication: 3 })).toBe(
      true,
    );
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
