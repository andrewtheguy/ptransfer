import type { Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS } from '../nostr/relays';
import { CONTROL_PROBE_BYTES, CONTROL_RELAY_COUNT } from './constants';
import { createMockPool } from './mock-pool';
import {
  type HealthyRelay,
  healthCheckRelays,
  parseRelayCandidates,
  type RelayPoolState,
  type RelayPoolStorage,
  selectUploadRelays,
} from './relay-pool';
import { createTransferStats } from './stats';
import { NOT_ENOUGH_RELAYS_MESSAGE, resolveControlRelays } from './upload';

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

  it('drops non-wss, onion, local, localhost, IP-literal, credentialed, and junk URLs', () => {
    const events = [
      makeEvent(10002, [
        ['r', 'ws://insecure.example'],
        ['r', 'https://not-a-relay.example'],
        ['r', 'wss://hidden.onion'],
        ['r', 'wss://box.local'],
        ['r', 'wss://localhost'],
        ['r', 'wss://dev.localhost'],
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

describe('control relay probe', () => {
  it('probes with a control-sized event and still requires read-back', async () => {
    const probeSizes: number[] = [];
    const pool = createMockPool({
      blackholeRelays: new Set([DEFAULT_RELAYS[1]]),
      beforePublish: (_relay, event) => {
        probeSizes.push(event.content.length);
      },
    });
    const healthy = await healthCheckRelays(pool, [...DEFAULT_RELAYS], {
      probeBytes: CONTROL_PROBE_BYTES,
      targetCount: DEFAULT_RELAYS.length,
    });
    // Small probe on the wire — nowhere near the 32 KiB chunk probe.
    expect(probeSizes.length).toBeGreaterThan(0);
    for (const size of probeSizes) expect(size).toBeLessThan(1000);
    // A relay that accepts writes but serves nothing back fails the probe.
    const urls = healthy.map((r) => r.url);
    expect(urls).not.toContain(DEFAULT_RELAYS[1]);
    expect(urls).toHaveLength(DEFAULT_RELAYS.length - 1);
  });
});

describe('resolveControlRelays', () => {
  const opts = () => ({
    isCancelled: () => false,
    onProgress: () => {},
    stats: createTransferStats('sender'),
  });

  it('returns a deduped override and seeds its stats rows', async () => {
    const pool = createMockPool();
    const o = opts();
    const relays = await resolveControlRelays(pool, {
      ...o,
      controlRelayOverride: [
        'wss://c1.example',
        'wss://c1.example',
        'wss://c2.example',
      ],
    });
    expect(relays).toEqual(['wss://c1.example', 'wss://c2.example']);
    expect(o.stats.relays.map((r) => r.url)).toEqual(relays);
  });

  it('rejects an override with fewer than two distinct relays', async () => {
    const pool = createMockPool();
    await expect(
      resolveControlRelays(pool, {
        ...opts(),
        controlRelayOverride: ['wss://c1.example', 'wss://c1.example'],
      }),
    ).rejects.toThrow(NOT_ENOUGH_RELAYS_MESSAGE);
  });

  it('picks probed default relays, skipping ones that serve nothing', async () => {
    const pool = createMockPool({
      blackholeRelays: new Set([DEFAULT_RELAYS[0]]),
    });
    const o = opts();
    const relays = await resolveControlRelays(pool, o);
    expect(relays.length).toBeLessThanOrEqual(CONTROL_RELAY_COUNT);
    expect(relays.length).toBeGreaterThanOrEqual(2);
    expect(relays).not.toContain(DEFAULT_RELAYS[0]);
    for (const url of relays) expect(DEFAULT_RELAYS).toContain(url);
    expect(o.stats.phaseMs.controlProbe).toBeGreaterThanOrEqual(0);
  });
});
