import type { Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS } from '../nostr/relays';
import { CONTROL_PROBE_BYTES, CONTROL_RELAY_COUNT } from './constants';
import { createMockPool } from './mock-pool';
import {
  getRelayCandidates,
  type HealthyRelay,
  healthCheckRelays,
  type KnownWorkingRelay,
  parseRelayCandidates,
  type RelayPoolState,
  type RelayPoolStorage,
  saveWorkingRelays,
  selectUploadRelays,
} from './relay-pool';
import { createTransferStats } from './stats';
import {
  NOT_ENOUGH_RELAYS_MESSAGE,
  resolveControlRelays,
  resolveUploadRelays,
} from './upload';

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
  workingRelays: KnownWorkingRelay[] = [],
): RelayPoolStorage & {
  state: RelayPoolState | null;
  workingRelays: KnownWorkingRelay[];
} {
  const holder = {
    state: initial,
    workingRelays,
    getState: async () => holder.state,
    setState: async (s: RelayPoolState) => {
      holder.state = s;
    },
    getWorkingRelays: async () => holder.workingRelays,
    setWorkingRelays: async (relays: KnownWorkingRelay[]) => {
      holder.workingRelays = relays;
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

  it('drops non-wss, onion, local, localhost, IP-literal, credentialed, reserved-domain, and junk URLs', () => {
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
        ['r', 'wss://example.com'],
        ['r', 'wss://relay.example.com'],
        ['r', 'wss://relay.example.net'],
        ['r', 'wss://relay.example.org'],
        ['r', 'wss://relay.test'],
        ['r', 'wss://relay.invalid'],
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

describe('getRelayCandidates', () => {
  it('re-filters cached candidates through the current normalization rules', async () => {
    // A cache written before a rule tightened (here: reserved domains) can
    // still be fresh — its entries must not reach the health check.
    const storage = memoryStorage({
      candidates: [
        'wss://relay.example.com',
        'wss://good.example/',
        'wss://good.example',
      ],
      discoveredAt: 1000,
      cursor: 0,
    });
    const candidates = await getRelayCandidates(
      createMockPool(),
      storage,
      2000,
    );
    expect(candidates).toEqual(['wss://good.example']);
  });

  it('falls through to discovery when the cache filters to nothing', async () => {
    const storage = memoryStorage({
      candidates: ['wss://relay.example.com'],
      discoveredAt: 1000,
      cursor: 3,
    });
    const candidates = await getRelayCandidates(
      createMockPool(),
      storage,
      2000,
    );
    expect(candidates).toEqual([]);
    // Discovery ran and persisted its (empty) result, keeping the cursor.
    expect(storage.state?.discoveredAt).toBe(2000);
    expect(storage.state?.cursor).toBe(3);
  });

  it('does not accept a candidate cache timestamped in the future', async () => {
    const storage = memoryStorage({
      candidates: ['wss://future.example'],
      discoveredAt: 3_000,
      cursor: 0,
    });
    const candidates = await getRelayCandidates(
      createMockPool(),
      storage,
      2_000,
    );
    expect(candidates).toEqual([]);
    expect(storage.state?.discoveredAt).toBe(2_000);
  });

  it('prioritizes recently working relays and ignores stale ones', async () => {
    const now = 2 * 24 * 60 * 60 * 1000;
    const storage = memoryStorage(
      {
        candidates: ['wss://candidate.example'],
        discoveredAt: now - 1_000,
        cursor: 0,
      },
      [
        { url: 'wss://stale.example', lastSavedAt: 0 },
        { url: 'wss://working.example', lastSavedAt: now - 500 },
      ],
    );
    const candidates = await getRelayCandidates(createMockPool(), storage, now);
    expect(candidates).toEqual([
      'wss://working.example',
      'wss://candidate.example',
    ]);
  });
});

describe('selectUploadRelays', () => {
  const healthy: HealthyRelay[] = [
    { url: 'wss://a', rttMs: 10 },
    { url: 'wss://b', rttMs: 20 },
    { url: 'wss://c', rttMs: 30 },
    { url: 'wss://d', rttMs: 40 },
  ];

  it('rotates the cursor across calls, wrapping modulo the pool', async () => {
    const storage = memoryStorage();
    await expect(selectUploadRelays(healthy, 3, storage)).resolves.toEqual([
      'wss://a',
      'wss://b',
      'wss://c',
    ]);
    await expect(selectUploadRelays(healthy, 3, storage)).resolves.toEqual([
      'wss://d',
      'wss://a',
      'wss://b',
    ]);
    expect(storage.state?.cursor).toBe(2);
  });

  it('caps the batch at the healthy pool size without duplicates', async () => {
    const storage = memoryStorage();
    await expect(
      selectUploadRelays(healthy.slice(0, 2), 6, storage),
    ).resolves.toEqual(['wss://a', 'wss://b']);
  });

  it('returns empty for an empty pool', async () => {
    await expect(selectUploadRelays([], 6, memoryStorage())).resolves.toEqual(
      [],
    );
  });

  it('preserves cached candidates while advancing the cursor', async () => {
    const storage = memoryStorage({
      candidates: ['wss://cached'],
      discoveredAt: 123,
      cursor: 0,
    });
    await selectUploadRelays(healthy, 2, storage);
    expect(storage.state?.candidates).toEqual(['wss://cached']);
    expect(storage.state?.discoveredAt).toBe(123);
  });
});

describe('saveWorkingRelays', () => {
  it('updates healthy relays, removes probed failures, and retains unprobed relays', async () => {
    const now = 24 * 60 * 60 * 1000;
    const storage = memoryStorage(null, [
      { url: 'wss://stale.example', lastSavedAt: 0 },
      { url: 'wss://failed.example/', lastSavedAt: now - 2 },
      { url: 'wss://still-good.example', lastSavedAt: now - 1 },
    ]);
    await saveWorkingRelays(
      storage,
      [
        { url: 'wss://new.example', rttMs: 10 },
        { url: 'wss://new.example/', rttMs: 20 },
      ],
      ['wss://failed.example', 'wss://new.example'],
      now,
    );
    expect(storage.workingRelays).toEqual([
      { url: 'wss://new.example', lastSavedAt: now },
      { url: 'wss://still-good.example', lastSavedAt: now - 1 },
    ]);
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
    // Small probe on the wire — nowhere near the full-size chunk probe.
    expect(probeSizes.length).toBeGreaterThan(0);
    for (const size of probeSizes) expect(size).toBeLessThan(1000);
    // A relay that accepts writes but serves nothing back fails the probe.
    const urls = healthy.map((r) => r.url);
    expect(urls).not.toContain(DEFAULT_RELAYS[1]);
    expect(urls).toHaveLength(DEFAULT_RELAYS.length - 1);
    // A failed probe also drops the socket so it stops reconnecting.
    expect(pool.closedRelays).toEqual([DEFAULT_RELAYS[1]]);
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
    // Equivalent URL forms collapse before the distinct-relay count.
    await expect(
      resolveControlRelays(pool, {
        ...opts(),
        controlRelayOverride: ['wss://c1.example', 'wss://c1.example/'],
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
    // Every seed is either picked for the channel or its socket is closed.
    for (const url of DEFAULT_RELAYS) {
      expect(relays.includes(url) || pool.closedRelays.includes(url)).toBe(
        true,
      );
    }
  });
});

describe('resolveUploadRelays', () => {
  const opts = () => ({
    isCancelled: () => false,
    onProgress: () => {},
    stats: createTransferStats('sender'),
  });

  it('never rings signaling relays, whether discovered or cached', async () => {
    const pool = createMockPool();
    const storage = memoryStorage();
    // NIP-66 events served by a seed relay: two real candidates plus a seed
    // that someone listed — the signaling pool must never come back.
    pool.store.set(DEFAULT_RELAYS[0], [
      makeEvent(30166, [['d', 'wss://s1.example']]),
      makeEvent(30166, [['d', 'wss://s2.example']]),
      makeEvent(30166, [['d', DEFAULT_RELAYS[2]]]),
    ]);
    const relays = await resolveUploadRelays(pool, storage, {
      ...opts(),
      excludeRelays: [DEFAULT_RELAYS[0], DEFAULT_RELAYS[1]],
    });
    expect(relays.sort()).toEqual(['wss://s1.example', 'wss://s2.example']);
    expect(storage.workingRelays.map((relay) => relay.url).sort()).toEqual([
      'wss://s1.example',
      'wss://s2.example',
    ]);
    expect(storage.workingRelays.every((relay) => relay.lastSavedAt > 0)).toBe(
      true,
    );
    // Seeds queried for discovery are closed once it finishes — except the
    // two carrying this transfer's control channel.
    for (const url of DEFAULT_RELAYS.slice(2)) {
      expect(pool.closedRelays).toContain(url);
    }
    expect(pool.closedRelays).not.toContain(DEFAULT_RELAYS[0]);
    expect(pool.closedRelays).not.toContain(DEFAULT_RELAYS[1]);

    // A candidate cache written before seeds were barred still lists one.
    const stale = memoryStorage({
      candidates: [DEFAULT_RELAYS[2], 'wss://s3.example', 'wss://s4.example'],
      discoveredAt: Date.now(),
      cursor: 0,
    });
    const fromCache = await resolveUploadRelays(pool, stale, {
      ...opts(),
      excludeRelays: [DEFAULT_RELAYS[0], DEFAULT_RELAYS[1]],
    });
    expect(fromCache.sort()).toEqual(['wss://s3.example', 'wss://s4.example']);
  });

  it('filters the override and refuses a ring the exclusion leaves too small', async () => {
    const pool = createMockPool();
    const override = ['wss://a.example', 'wss://b.example', 'wss://c.example'];
    const relays = await resolveUploadRelays(pool, memoryStorage(), {
      ...opts(),
      relayOverride: override,
      // Trailing slash on purpose: exclusion matches normalized URLs.
      excludeRelays: ['wss://c.example/'],
    });
    expect(relays).toEqual(['wss://a.example', 'wss://b.example']);
    await expect(
      resolveUploadRelays(pool, memoryStorage(), {
        ...opts(),
        relayOverride: override,
        excludeRelays: ['wss://b.example', 'wss://c.example'],
      }),
    ).rejects.toThrow(NOT_ENOUGH_RELAYS_MESSAGE);
    // A trailing-slash variant is the same relay, not a second one.
    await expect(
      resolveUploadRelays(pool, memoryStorage(), {
        ...opts(),
        relayOverride: ['wss://a.example', 'wss://a.example/'],
        excludeRelays: [],
      }),
    ).rejects.toThrow(NOT_ENOUGH_RELAYS_MESSAGE);
  });
});
