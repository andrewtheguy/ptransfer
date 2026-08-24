import type { Event as NostrEvent } from 'nostr-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RELAYS, normalizeRelayUrl } from '../nostr/relays';
import {
  CONTROL_PROBE_BYTES,
  CONTROL_RELAY_COUNT,
  RELAY_CACHE_HEALTH_STORE,
  RELAY_CACHE_STATE_STORE,
} from './constants';
import { createMockPool } from './mock-pool';
import {
  type CachedRelay,
  createIndexedDbRelayPool,
  getRelayCandidates,
  type HealthyRelay,
  healthCheckRelays,
  parseRelayCandidates,
  type RelayPoolState,
  type RelayPoolStorage,
  saveRelayHealth,
  selectUploadRelays,
} from './relay-pool';
import { createTransferStats } from './stats';
import {
  NOT_ENOUGH_RELAYS_MESSAGE,
  resolveTransferRelays,
  resolveUploadRelays,
} from './upload';

afterEach(() => vi.unstubAllGlobals());

function makeEvent(kind: number, tags: string[][]): NostrEvent {
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
  relayHealth: CachedRelay[] = [],
): RelayPoolStorage & {
  state: RelayPoolState | null;
  relayHealth: CachedRelay[];
} {
  const holder = {
    state: initial,
    relayHealth,
    getState: async () => holder.state,
    setState: async (s: RelayPoolState) => {
      holder.state = s;
    },
    getRelayHealth: async () => holder.relayHealth,
    setRelayHealth: async (relays: CachedRelay[]) => {
      holder.relayHealth = relays;
    },
  };
  return holder;
}

function cachedRelay(
  url: string,
  overrides: Partial<Omit<CachedRelay, 'url'>> = {},
): CachedRelay {
  return {
    url,
    lastDiscoveredAt: 0,
    lastCheckedAt: null,
    lastSucceededAt: null,
    rttMs: null,
    consecutiveFailures: 0,
    supportsControl: false,
    supportsStorage: false,
    ...overrides,
  };
}

function mockRelayCacheUpgrade(oldVersion: number, initialStores: string[]) {
  type Handler<T extends Event = Event> = ((event: T) => void) | null;

  const stores = [...initialStores];
  const deleted: string[] = [];
  const created: string[] = [];
  const readRequest = {
    result: undefined,
    error: null,
    onsuccess: null as Handler,
    onerror: null as Handler,
  };
  const transaction = {
    error: null,
    oncomplete: null as Handler,
    onerror: null as Handler,
    onabort: null as Handler,
    objectStore: () => ({
      get: () => {
        queueMicrotask(() => {
          readRequest.onsuccess?.(new Event('success'));
          queueMicrotask(() => transaction.oncomplete?.(new Event('complete')));
        });
        return readRequest as unknown as IDBRequest<unknown>;
      },
    }),
  };
  const database = {
    objectStoreNames: stores,
    deleteObjectStore: (name: string) => {
      deleted.push(name);
      const index = stores.indexOf(name);
      if (index >= 0) stores.splice(index, 1);
    },
    createObjectStore: (name: string) => {
      created.push(name);
      stores.push(name);
    },
    transaction: () => transaction as unknown as IDBTransaction,
    close: vi.fn(),
  };
  const openRequest = {
    result: database as unknown as IDBDatabase,
    error: null,
    onupgradeneeded: null as Handler<IDBVersionChangeEvent>,
    onsuccess: null as Handler,
    onerror: null as Handler,
    onblocked: null as Handler,
  };
  vi.stubGlobal('indexedDB', {
    open: vi.fn(() => {
      queueMicrotask(() => {
        openRequest.onupgradeneeded?.({ oldVersion } as IDBVersionChangeEvent);
        openRequest.onsuccess?.(new Event('success'));
      });
      return openRequest as unknown as IDBOpenDBRequest;
    }),
  });

  return { stores, deleted, created, close: database.close };
}

describe('IndexedDB relay cache schema', () => {
  it('creates the current stores for a new database', async () => {
    const database = mockRelayCacheUpgrade(0, []);

    await expect(createIndexedDbRelayPool().getState()).resolves.toBeNull();

    expect(database.deleted).toEqual([]);
    expect(database.created).toEqual([
      RELAY_CACHE_STATE_STORE,
      RELAY_CACHE_HEALTH_STORE,
    ]);
    expect(database.stores).toEqual(database.created);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('resets every store when the database version changes', async () => {
    const previousStores = [
      RELAY_CACHE_STATE_STORE,
      'working-relays',
      'obsolete-store',
    ];
    const database = mockRelayCacheUpgrade(1, previousStores);

    await expect(createIndexedDbRelayPool().getState()).resolves.toBeNull();

    expect(database.deleted).toEqual(previousStores);
    expect(database.created).toEqual([
      RELAY_CACHE_STATE_STORE,
      RELAY_CACHE_HEALTH_STORE,
    ]);
    expect(database.stores).toEqual(database.created);
    expect(database.close).toHaveBeenCalledOnce();
  });
});

describe('parseRelayCandidates', () => {
  it('uses one canonical relay identity for cache keys and connections', () => {
    expect(
      normalizeRelayUrl(
        '  WSS://Relay.Example:443/path///?tenant=one#ignored  ',
      ),
    ).toBe('wss://relay.example/path?tenant=one');
    expect(normalizeRelayUrl('wss://relay.example/')).toBe(
      normalizeRelayUrl('wss://RELAY.EXAMPLE:443'),
    );
  });

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
        cachedRelay('wss://stale.example', {
          lastSucceededAt: 0,
          rttMs: 100,
          supportsControl: true,
          supportsStorage: true,
        }),
        cachedRelay('wss://working.example', {
          lastDiscoveredAt: now - 500,
          lastCheckedAt: now - 500,
          lastSucceededAt: now - 500,
          rttMs: 25,
          supportsControl: true,
          supportsStorage: true,
        }),
        cachedRelay('wss://slower.example', {
          lastDiscoveredAt: now - 100,
          lastCheckedAt: now - 100,
          lastSucceededAt: now - 100,
          rttMs: 90,
          supportsControl: true,
          supportsStorage: true,
        }),
      ],
    );
    const candidates = await getRelayCandidates(createMockPool(), storage, now);
    expect(candidates).toEqual([
      'wss://working.example',
      'wss://slower.example',
      'wss://candidate.example',
    ]);
  });

  it('merges newly discovered relays into a fresh cache', async () => {
    const now = 2_000;
    const storage = memoryStorage({
      candidates: ['wss://cached.example'],
      discoveredAt: 1_000,
      cursor: 3,
    });
    const pool = createMockPool();
    pool.store.set(DEFAULT_RELAYS[0], [
      makeEvent(30166, [['d', 'wss://new.example']]),
    ]);

    const candidates = await getRelayCandidates(pool, storage, now);

    expect(candidates).toEqual(['wss://new.example', 'wss://cached.example']);
    expect(storage.state).toEqual({
      candidates,
      discoveredAt: now,
      cursor: 3,
    });
    expect(storage.relayHealth).toEqual([
      cachedRelay('wss://new.example', { lastDiscoveredAt: now }),
      cachedRelay('wss://cached.example', { lastDiscoveredAt: 1_000 }),
    ]);
  });

  it('ranks unfailed cached candidates ahead of repeated failures', async () => {
    const now = 2_000;
    const storage = memoryStorage(
      {
        candidates: ['wss://failed.example', 'wss://unfailed.example'],
        discoveredAt: 1_000,
        cursor: 0,
      },
      [
        cachedRelay('wss://failed.example', {
          lastDiscoveredAt: 1_000,
          lastCheckedAt: 1_500,
          consecutiveFailures: 2,
        }),
        cachedRelay('wss://unfailed.example', {
          lastDiscoveredAt: 1_000,
        }),
      ],
    );

    const candidates = await getRelayCandidates(createMockPool(), storage, now);

    expect(candidates).toEqual([
      'wss://unfailed.example',
      'wss://failed.example',
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

describe('saveRelayHealth', () => {
  it('records probe metadata, canonicalizes keys, and retains bounded failure history', async () => {
    const now = 24 * 60 * 60 * 1000;
    const storage = memoryStorage(null, [
      cachedRelay('wss://stale.example', {
        lastSucceededAt: 0,
        supportsControl: true,
        supportsStorage: true,
      }),
      cachedRelay('wss://failed.example/', {
        lastDiscoveredAt: now - 2,
        lastCheckedAt: now - 2,
        lastSucceededAt: now - 2,
        rttMs: 20,
        supportsControl: true,
        supportsStorage: true,
      }),
      cachedRelay('wss://still-good.example', {
        lastDiscoveredAt: now - 1,
        lastCheckedAt: now - 1,
        lastSucceededAt: now - 1,
        rttMs: 30,
        supportsControl: true,
        supportsStorage: true,
      }),
    ]);
    await saveRelayHealth(
      storage,
      [
        { url: 'wss://new.example', rttMs: 10 },
        { url: 'wss://new.example/', rttMs: 20 },
      ],
      ['wss://failed.example'],
      now,
    );
    expect(storage.relayHealth).toEqual([
      cachedRelay('wss://new.example', {
        lastDiscoveredAt: now,
        lastCheckedAt: now,
        lastSucceededAt: now,
        rttMs: 10,
        supportsControl: true,
        supportsStorage: true,
      }),
      cachedRelay('wss://still-good.example', {
        lastDiscoveredAt: now - 1,
        lastCheckedAt: now - 1,
        lastSucceededAt: now - 1,
        rttMs: 30,
        supportsControl: true,
        supportsStorage: true,
      }),
      cachedRelay('wss://failed.example', {
        lastDiscoveredAt: now - 2,
        lastCheckedAt: now,
        lastSucceededAt: now - 2,
        consecutiveFailures: 1,
      }),
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

describe('resolveTransferRelays', () => {
  const opts = () => ({
    isCancelled: () => false,
    onControlProgress: () => {},
    onUploadProgress: () => {},
    stats: createTransferStats('sender'),
  });

  it('returns a deduped override and seeds its stats rows', async () => {
    const pool = createMockPool();
    const o = opts();
    const selection = await resolveTransferRelays(pool, memoryStorage(), {
      ...o,
      controlRelayOverride: [
        'wss://c1.example',
        'wss://c1.example',
        'wss://c2.example',
      ],
    });
    const relays = selection.controlRelays;
    expect(relays).toEqual(['wss://c1.example', 'wss://c2.example']);
    expect(selection.storageRelays).toBeNull();
    expect(o.stats.relays.map((r) => r.url)).toEqual(relays);
  });

  it('rejects an override with fewer than two distinct relays', async () => {
    const pool = createMockPool();
    await expect(
      resolveTransferRelays(pool, memoryStorage(), {
        ...opts(),
        controlRelayOverride: ['wss://c1.example', 'wss://c1.example'],
      }),
    ).rejects.toThrow(NOT_ENOUGH_RELAYS_MESSAGE);
    // Equivalent URL forms collapse before the distinct-relay count.
    await expect(
      resolveTransferRelays(pool, memoryStorage(), {
        ...opts(),
        controlRelayOverride: ['wss://c1.example', 'wss://c1.example/'],
      }),
    ).rejects.toThrow(NOT_ENOUGH_RELAYS_MESSAGE);
  });

  it('fills failed default signaling relays from the four storage reserves', async () => {
    const candidates = Array.from(
      { length: 20 },
      (_, i) => `wss://storage-${i}.example`,
    );
    const pool = createMockPool({
      blackholeRelays: new Set([DEFAULT_RELAYS[0]]),
    });
    pool.store.set(
      DEFAULT_RELAYS[1],
      candidates.map((url) => makeEvent(30166, [['d', url]])),
    );
    const o = opts();
    const selection = await resolveTransferRelays(pool, memoryStorage(), o);
    const relays = selection.controlRelays;
    const defaultSet = new Set<string>(DEFAULT_RELAYS);
    expect(relays).toHaveLength(CONTROL_RELAY_COUNT);
    expect(relays).not.toContain(DEFAULT_RELAYS[0]);
    expect(relays.filter((url) => !defaultSet.has(url))).toHaveLength(1);
    expect(selection.storageRelays).toHaveLength(16);
    for (const url of selection.storageRelays ?? []) {
      expect(relays).not.toContain(url);
    }
    expect(o.stats.phaseMs.controlProbe).toBeGreaterThanOrEqual(0);
    // Every default is either picked for the channel or its socket is closed.
    for (const url of DEFAULT_RELAYS) {
      expect(relays.includes(url) || pool.closedRelays.includes(url)).toBe(
        true,
      );
    }
  });

  it('uses cached storage reserves when every default signaling relay fails', async () => {
    const now = Date.now();
    const candidates = Array.from(
      { length: 20 },
      (_, i) => `wss://cached-${i}.example`,
    );
    const storage = memoryStorage({
      candidates,
      discoveredAt: now,
      cursor: 0,
    });
    const pool = createMockPool({
      blackholeRelays: new Set(DEFAULT_RELAYS),
    });

    const selection = await resolveTransferRelays(pool, storage, opts());

    expect(selection.storageRelays).toHaveLength(16);
    expect(selection.controlRelays).toHaveLength(4);
    expect(
      new Set([...(selection.storageRelays ?? []), ...selection.controlRelays]),
    ).toEqual(new Set(candidates));
    for (const relay of selection.controlRelays) {
      expect(selection.storageRelays).not.toContain(relay);
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
    const { storageRelays: relays } = await resolveUploadRelays(pool, storage, {
      ...opts(),
      excludeRelays: [DEFAULT_RELAYS[0], DEFAULT_RELAYS[1]],
    });
    expect(relays.sort()).toEqual(['wss://s1.example', 'wss://s2.example']);
    expect(storage.relayHealth.map((relay) => relay.url).sort()).toEqual([
      'wss://s1.example',
      'wss://s2.example',
    ]);
    expect(
      storage.relayHealth.every(
        (relay) =>
          relay.lastCheckedAt !== null &&
          relay.lastSucceededAt !== null &&
          relay.rttMs !== null &&
          relay.supportsControl &&
          relay.supportsStorage,
      ),
    ).toBe(true);
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
    const { storageRelays: fromCache } = await resolveUploadRelays(
      pool,
      stale,
      {
        ...opts(),
        excludeRelays: [DEFAULT_RELAYS[0], DEFAULT_RELAYS[1]],
      },
    );
    expect(fromCache.sort()).toEqual([
      'wss://s1.example',
      'wss://s2.example',
      'wss://s3.example',
      'wss://s4.example',
    ]);
  });

  it('records successful probes that finish after the target is reached', async () => {
    const candidates = Array.from(
      { length: 21 },
      (_, i) => `wss://candidate-${i}.example`,
    );
    let releaseSlowProbe = () => {};
    const slowProbe = new Promise<void>((resolve) => {
      releaseSlowProbe = resolve;
    });
    let otherProbesStarted = 0;
    const candidateSet = new Set(candidates);
    const pool = createMockPool({
      beforePublish: async (relay) => {
        if (relay === candidates[0]) {
          await slowProbe;
        } else if (candidateSet.has(relay)) {
          otherProbesStarted++;
          if (otherProbesStarted === candidates.length - 1) releaseSlowProbe();
        }
      },
    });
    const storage = memoryStorage({
      candidates,
      discoveredAt: Date.now(),
      cursor: 0,
    });

    await resolveUploadRelays(pool, storage, {
      ...opts(),
      excludeRelays: [],
    });

    expect(storage.relayHealth).toHaveLength(candidates.length);
    expect(
      storage.relayHealth.every(
        (relay) =>
          relay.supportsStorage &&
          relay.lastSucceededAt !== null &&
          relay.consecutiveFailures === 0,
      ),
    ).toBe(true);
  });

  it('filters the override and refuses a ring the exclusion leaves too small', async () => {
    const pool = createMockPool();
    const override = ['wss://a.example', 'wss://b.example', 'wss://c.example'];
    const { storageRelays: relays } = await resolveUploadRelays(
      pool,
      memoryStorage(),
      {
        ...opts(),
        relayOverride: override,
        // Trailing slash on purpose: exclusion matches normalized URLs.
        excludeRelays: ['wss://c.example/'],
      },
    );
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
