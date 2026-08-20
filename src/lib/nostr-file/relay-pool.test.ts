import type { Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  type HealthyRelay,
  parseRelayCandidates,
  type RelayPoolState,
  type RelayPoolStorage,
  selectUploadRelays,
} from './relay-pool';

function makeEvent(kind: number, tags: string[][]): Event {
  return {
    kind,
    tags,
    content: '',
    created_at: 0,
    pubkey: 'p',
    id: 'i',
    sig: 's',
  };
}

function memoryStorage(
  initial: RelayPoolState | null = null,
): RelayPoolStorage & {
  state: RelayPoolState | null;
} {
  const holder = {
    state: initial,
    get: () => holder.state,
    set: (s: RelayPoolState) => {
      holder.state = s;
    },
  };
  return holder;
}

describe('parseRelayCandidates', () => {
  it('extracts NIP-66 d tags and NIP-65 r tags, normalized and deduped', () => {
    const events = [
      makeEvent(30166, [['d', 'wss://relay.one/']]),
      makeEvent(30166, [['d', 'wss://relay.one']]),
      makeEvent(10002, [
        ['r', 'wss://relay.two'],
        ['r', 'wss://relay.three/', 'read'],
      ]),
    ];
    expect(parseRelayCandidates(events).sort()).toEqual([
      'wss://relay.one',
      'wss://relay.three',
      'wss://relay.two',
    ]);
  });

  it('drops non-wss, onion, local, IP-literal, credentialed, and junk URLs', () => {
    const events = [
      makeEvent(10002, [
        ['r', 'ws://insecure.example'],
        ['r', 'https://not-a-relay.example'],
        ['r', 'wss://hidden.onion'],
        ['r', 'wss://box.local'],
        ['r', 'wss://192.168.1.1'],
        ['r', 'wss://user:pass@relay.example'],
        ['r', 'not a url'],
        ['r', 'wss://good.example'],
      ]),
    ];
    expect(parseRelayCandidates(events)).toEqual(['wss://good.example']);
  });

  it('ignores unrelated event kinds', () => {
    expect(
      parseRelayCandidates([makeEvent(1, [['r', 'wss://relay.example']])]),
    ).toEqual([]);
  });
});

describe('selectUploadRelays', () => {
  const healthy: HealthyRelay[] = [
    { url: 'wss://a', rttMs: 10 },
    { url: 'wss://b', rttMs: 20 },
    { url: 'wss://c', rttMs: 30 },
    { url: 'wss://d', rttMs: 40 },
  ];

  it('rotates the cursor across calls, wrapping modulo the pool', () => {
    const storage = memoryStorage();
    expect(selectUploadRelays(healthy, 3, storage)).toEqual([
      'wss://a',
      'wss://b',
      'wss://c',
    ]);
    expect(selectUploadRelays(healthy, 3, storage)).toEqual([
      'wss://d',
      'wss://a',
      'wss://b',
    ]);
    expect(storage.state?.cursor).toBe(2);
  });

  it('caps the batch at the healthy pool size without duplicates', () => {
    const storage = memoryStorage();
    expect(selectUploadRelays(healthy.slice(0, 2), 6, storage)).toEqual([
      'wss://a',
      'wss://b',
    ]);
  });

  it('returns empty for an empty pool', () => {
    expect(selectUploadRelays([], 6, memoryStorage())).toEqual([]);
  });

  it('preserves cached candidates while advancing the cursor', () => {
    const storage = memoryStorage({
      candidates: ['wss://cached'],
      discoveredAt: 123,
      cursor: 0,
    });
    selectUploadRelays(healthy, 2, storage);
    expect(storage.state?.candidates).toEqual(['wss://cached']);
    expect(storage.state?.discoveredAt).toBe(123);
  });
});
