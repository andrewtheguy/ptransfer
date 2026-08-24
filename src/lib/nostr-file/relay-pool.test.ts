import type { Event as NostrEvent } from 'nostr-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RELAYS, normalizeRelayUrl } from '../nostr/relays';
import {
  CONTROL_PROBE_BYTES,
  CONTROL_RELAY_COUNT,
  DISCOVERY_CANDIDATE_CAP,
  DISCOVERY_CANDIDATE_LIMIT,
  RELAY_CACHE_HEALTH_STORE,
  RELAY_CACHE_STATE_STORE,
  UPLOAD_RELAY_COUNT,
} from './constants';
import { createMockPool } from './mock-pool';
import {
  type CachedRelay,
  createIndexedDbRelayPool,
  discoverAllRelayCandidates,
  discoverRelayCandidates,
  getRelayCandidates,
  type HealthyRelay,
  healthCheckRelays,
  parseRelayCandidates,
  type RelayPoolState,
  type RelayPoolStorage,
  saveRelayHealth,
  selectUploadRelays,
  sweepRelayHealth,
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
    const candidates = await getRelayCandidates(createMockPool(), storage, {
      now: 2000,
    });
    expect(candidates).toEqual(['wss://good.example']);
  });

  it('falls through to discovery when the cache filters to nothing', async () => {
    const storage = memoryStorage({
      candidates: ['wss://relay.example.com'],
      discoveredAt: 1000,
      cursor: 3,
    });
    const candidates = await getRelayCandidates(createMockPool(), storage, {
      now: 2000,
    });
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
    const candidates = await getRelayCandidates(createMockPool(), storage, {
      now: 2_000,
    });
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
    const candidates = await getRelayCandidates(createMockPool(), storage, {
      now,
    });
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

    const candidates = await getRelayCandidates(pool, storage, { now });

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

    const candidates = await getRelayCandidates(createMockPool(), storage, {
      now,
    });

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
      { capability: 'storage', now },
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

  it('hands back the candidates the early stop never probed', async () => {
    const candidates = Array.from(
      { length: 60 },
      (_, i) => `wss://leftover-${i}.example`,
    );
    const pool = createMockPool();
    const storage = memoryStorage({
      candidates,
      discoveredAt: Date.now(),
      cursor: 0,
    });
    const { storageRelays, unprobedCandidates } = await resolveUploadRelays(
      pool,
      storage,
      { ...opts(), excludeRelays: [] },
    );
    expect(storageRelays).toHaveLength(UPLOAD_RELAY_COUNT);
    // The health check stopped well short of the list; the rest comes back
    // for the background sweep instead of being dropped.
    expect(unprobedCandidates.length).toBeGreaterThan(0);
    const probed = storage.relayHealth
      .filter((relay) => relay.lastCheckedAt !== null)
      .map((relay) => relay.url);
    expect(probed.length + unprobedCandidates.length).toBe(candidates.length);
    for (const url of unprobedCandidates) {
      expect(probed).not.toContain(url);
      expect(candidates).toContain(url);
    }
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

describe('discoverAllRelayCandidates', () => {
  it('enumerates the whole population instead of sampling one capped page', async () => {
    const total = DISCOVERY_CANDIDATE_CAP + 60;
    const pool = createMockPool();
    // Distinct created_at values, newest first — what a real relay pages over.
    pool.store.set(
      DEFAULT_RELAYS[0],
      Array.from({ length: total }, (_, i) => ({
        ...makeEvent(30166, [['d', `wss://pop-${i}.example`]]),
        id: `e${i}`,
        created_at: total - i,
      })),
    );

    // Foreground: one page, bounded by the per-kind query limit. It only has
    // to fill a ring, so it never sees most of the population.
    const sampled = await discoverRelayCandidates(pool);
    expect(sampled).toHaveLength(DISCOVERY_CANDIDATE_LIMIT);
    expect(sampled.length).toBeLessThan(total);

    // Background: pages back by created_at until exhausted. No cap.
    const all = await discoverAllRelayCandidates(pool, [...DEFAULT_RELAYS], {
      pageLimit: 50,
    });
    expect(all).toHaveLength(total);
    expect(all.length).toBeGreaterThan(DISCOVERY_CANDIDATE_CAP);
  });

  it('stops paging when the cursor cannot move and never returns a seed', async () => {
    const pool = createMockPool();
    // Every event shares one timestamp, so `until` cannot step past them.
    pool.store.set(DEFAULT_RELAYS[0], [
      { ...makeEvent(30166, [['d', 'wss://same-1.example']]), id: 'a' },
      { ...makeEvent(30166, [['d', 'wss://same-2.example']]), id: 'b' },
      { ...makeEvent(30166, [['d', DEFAULT_RELAYS[2]]]), id: 'c' },
    ]);
    const found = await discoverAllRelayCandidates(pool, [...DEFAULT_RELAYS], {
      pageLimit: 1,
    });
    expect(found).not.toContain(DEFAULT_RELAYS[2]);
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('sweepRelayHealth', () => {
  it('probes every leftover candidate, caches the verdict, and drops the sockets', async () => {
    const candidates = [
      'wss://sweep-a.example',
      'wss://sweep-b.example',
      'wss://sweep-c.example',
    ];
    // The middle relay acknowledges writes but serves nothing back.
    const pool = createMockPool({ blackholeRelays: new Set([candidates[1]]) });
    const storage = memoryStorage();
    await sweepRelayHealth(pool, storage, {
      // Duplicate and junk entries collapse away before probing.
      unprobed: [
        ...candidates,
        'wss://sweep-a.example/',
        'http://sweep-a.example',
      ],
      saveBatch: 2,
    });
    const byUrl = new Map(storage.relayHealth.map((r) => [r.url, r]));
    expect([...byUrl.keys()].sort()).toEqual([...candidates].sort());
    expect(byUrl.get(candidates[0])?.supportsStorage).toBe(true);
    expect(byUrl.get(candidates[0])?.rttMs).not.toBeNull();
    expect(byUrl.get(candidates[1])?.supportsStorage).toBe(false);
    expect(byUrl.get(candidates[1])?.consecutiveFailures).toBe(1);
    expect(byUrl.get(candidates[2])?.supportsStorage).toBe(true);
    // None of these relays carry the transfer, so every probed socket is
    // closed instead of left reconnecting behind the upload.
    for (const url of candidates) expect(pool.closedRelays).toContain(url);
  });

  it('enumerates uncapped, caches the enumeration before probing, and leaves the transfer alone', async () => {
    const found = Array.from(
      { length: DISCOVERY_CANDIDATE_CAP + 40 },
      (_, i) => `wss://found-${i}.example`,
    );
    const ring = ['wss://ring-1.example', 'wss://ring-2.example'];
    let probes = 0;
    const pool = createMockPool({
      beforePublish: (relay) => {
        if (relay.startsWith('wss://found-')) probes++;
      },
    });
    pool.store.set(
      DEFAULT_RELAYS[0],
      found.map((url, i) => ({
        ...makeEvent(30166, [['d', url]]),
        id: `d${i}`,
        created_at: found.length - i,
      })),
    );
    const storage = memoryStorage();
    const controller = new AbortController();
    // Cut the sweep off early, as a finishing transfer would.
    const sweep = sweepRelayHealth(pool, storage, {
      excludeRelays: [...ring, DEFAULT_RELAYS[0]],
      concurrency: 2,
      saveBatch: 4,
      signal: controller.signal,
      onProgress: (checked) => {
        if (checked >= 6) controller.abort();
      },
    });
    await sweep;

    const cached = storage.relayHealth.map((relay) => relay.url);
    // The enumeration is cached whole even though probing got nowhere near
    // the end — that is the part the next transfer needs.
    expect(cached.length).toBeGreaterThan(DISCOVERY_CANDIDATE_CAP);
    for (const url of found) expect(cached).toContain(url);
    expect(probes).toBeLessThan(found.length);
    // Relays carrying the transfer are never probed and never closed.
    for (const url of ring) {
      expect(cached).not.toContain(url);
      expect(pool.closedRelays).not.toContain(url);
    }
    expect(pool.closedRelays).not.toContain(DEFAULT_RELAYS[0]);
  });

  it('probes the longest-unchecked relays first so later sessions extend coverage', async () => {
    const order: string[] = [];
    const pool = createMockPool({
      beforePublish: (relay) => {
        if (relay.startsWith('wss://age-')) order.push(relay);
      },
    });
    const storage = memoryStorage(null, [
      cachedRelay('wss://age-recent.example', {
        lastDiscoveredAt: Date.now(),
        lastCheckedAt: Date.now(),
      }),
      cachedRelay('wss://age-old.example', {
        lastDiscoveredAt: Date.now(),
        lastCheckedAt: 1,
      }),
    ]);
    await sweepRelayHealth(pool, storage, {
      unprobed: [
        'wss://age-recent.example',
        'wss://age-old.example',
        'wss://age-never.example',
      ],
      concurrency: 1,
    });
    // Never checked, then longest-unchecked, then the freshest verdict.
    expect(order).toEqual([
      'wss://age-never.example',
      'wss://age-old.example',
      'wss://age-recent.example',
    ]);
  });

  it('accumulates working relays across batches so the next transfer starts from them', async () => {
    const working = [
      'wss://sweep-ok-1.example',
      'wss://sweep-ok-2.example',
      'wss://sweep-ok-3.example',
    ];
    const dead = ['wss://sweep-dead-1.example', 'wss://sweep-dead-2.example'];
    const pool = createMockPool({ blackholeRelays: new Set(dead) });
    const storage = memoryStorage();
    // Small batches: every flush has to merge onto the previous one, not
    // replace it, or only the last batch would survive.
    await sweepRelayHealth(pool, storage, {
      unprobed: [...working, ...dead],
      saveBatch: 2,
    });
    expect(
      storage.relayHealth
        .filter((relay) => relay.supportsStorage)
        .map((relay) => relay.url)
        .sort(),
    ).toEqual([...working].sort());

    // The point of sweeping: a later transfer with nothing else to go on —
    // no candidate state, no discovery events — still starts from the relays
    // this sweep proved, and never from the ones it buried.
    const seeded = await getRelayCandidates(createMockPool(), storage);
    expect([...seeded].sort()).toEqual([...working].sort());

    // And when discovery does return a candidate list, the swept relays lead
    // it, so the next ring is drawn from them before anything unproven.
    storage.state = {
      candidates: ['wss://unproven.example', ...working],
      discoveredAt: Date.now(),
      cursor: 0,
    };
    const ranked = await getRelayCandidates(createMockPool(), storage);
    expect(ranked.slice(0, working.length).sort()).toEqual([...working].sort());
    expect(ranked).toContain('wss://unproven.example');
  });

  it('returns without waiting out an in-flight discovery page on abort', async () => {
    const controller = new AbortController();
    let releaseQuery = () => {};
    const hung = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const pool = createMockPool();
    // Discovery only checks the abort flag between pages, so this stands in
    // for a page still waiting on DISCOVERY_PAGE_MAX_WAIT_MS at teardown.
    const stalled = {
      ...pool,
      querySync: async () => {
        controller.abort();
        await hung;
        return [];
      },
    };
    const storage = memoryStorage();

    await sweepRelayHealth(stalled, storage, {
      unprobed: ['wss://stalled.example'],
      signal: controller.signal,
    });

    // Resolving at all is the assertion: the hung page is still unresolved.
    expect(storage.relayHealth).toEqual([]);
    expect(pool.closedRelays).toEqual([]);
    releaseQuery();
  });

  it('ends on abort without recording probes that raced the shutdown', async () => {
    const controller = new AbortController();
    let probesStarted = 0;
    const pool = createMockPool({
      beforePublish: async (relay) => {
        if (!relay.startsWith('wss://abort-')) return;
        probesStarted++;
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    const storage = memoryStorage();
    await sweepRelayHealth(pool, storage, {
      unprobed: Array.from(
        { length: 20 },
        (_, i) => `wss://abort-${i}.example`,
      ),
      concurrency: 2,
      signal: controller.signal,
    });
    // The two in-flight probes are abandoned rather than waited out, and a
    // verdict reached against a pool being torn down is thrown away.
    expect(probesStarted).toBeLessThanOrEqual(2);
    expect(
      storage.relayHealth.every((relay) => relay.lastCheckedAt === null),
    ).toBe(true);
  });
});
