import type { Event, Filter } from 'nostr-tools';
import { wipeBufferSource } from '../crypto/memory';
import { generateEphemeralKeys } from '../nostr/events';
import { DEFAULT_RELAYS, normalizeRelayUrl } from '../nostr/relays';
import { chunkAad, decodeChunkContent, encodeChunkContent } from './codec';
import {
  BACKGROUND_PROBE_CONCURRENCY,
  BACKGROUND_PROBE_SAVE_BATCH,
  DISCOVERY_CANDIDATE_CAP,
  DISCOVERY_CANDIDATE_LIMIT,
  DISCOVERY_MAX_PAGES,
  DISCOVERY_PAGE_LIMIT,
  DISCOVERY_PAGE_MAX_WAIT_MS,
  EVENT_KIND_FILE_CHUNK,
  HEALTH_CHECK_CONCURRENCY,
  HEALTH_CHECK_PROBE_BYTES,
  HEALTH_CHECK_TARGET_COUNT,
  HEALTH_CHECK_TIMEOUT_MS,
  RELAY_CACHE_DATABASE_NAME,
  RELAY_CACHE_DATABASE_VERSION,
  RELAY_CACHE_HEALTH_STORE,
  RELAY_CACHE_MAX_ENTRIES,
  RELAY_CACHE_STATE_STORE,
  RELAY_CANDIDATE_TTL_MS,
} from './constants';
import { buildProbeEvent } from './events';
import type { NostrFilePool } from './pool';

// NIP-66 relay discovery events and NIP-65 relay list metadata.
const KIND_RELAY_DISCOVERY = 30166;
const KIND_RELAY_LIST = 10002;

/**
 * What a probe proved about a relay. `storage` is a full-size chunk write; a
 * relay that passes it necessarily takes a control-sized message too, so the
 * two flags are not independent. `control` is the small write the control
 * channel needs.
 */
export type RelayCapability = 'control' | 'storage';

export interface HealthyRelay {
  url: string;
  rttMs: number;
}

export interface RelayPoolState {
  candidates: string[];
  discoveredAt: number;
  cursor: number;
}

export interface CachedRelay {
  url: string;
  lastDiscoveredAt: number;
  lastCheckedAt: number | null;
  lastSucceededAt: number | null;
  rttMs: number | null;
  consecutiveFailures: number;
  supportsControl: boolean;
  supportsStorage: boolean;
}

/** Injected persistence so node tests never touch IndexedDB. */
export interface RelayPoolStorage {
  getState(): Promise<RelayPoolState | null>;
  setState(state: RelayPoolState): Promise<void>;
  getRelayHealth(): Promise<CachedRelay[]>;
  setRelayHealth(relays: CachedRelay[]): Promise<void>;
}

const RELAY_POOL_STATE_KEY = 'current';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openRelayCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      RELAY_CACHE_DATABASE_NAME,
      RELAY_CACHE_DATABASE_VERSION,
    );
    request.onupgradeneeded = (event) => {
      const database = request.result;
      // The relay cache is disposable. A database-version change always
      // resets it to the current schema instead of migrating or retaining
      // stores from an older version.
      if (event.oldVersion !== 0) {
        for (const storeName of Array.from(database.objectStoreNames)) {
          database.deleteObjectStore(storeName);
        }
      }
      database.createObjectStore(RELAY_CACHE_STATE_STORE);
      database.createObjectStore(RELAY_CACHE_HEALTH_STORE, {
        keyPath: 'url',
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Relay cache upgrade blocked'));
  });
}

function parseRelayPoolState(value: unknown): RelayPoolState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (
    !Array.isArray(state.candidates) ||
    !state.candidates.every((candidate) => typeof candidate === 'string') ||
    typeof state.discoveredAt !== 'number' ||
    !Number.isFinite(state.discoveredAt) ||
    typeof state.cursor !== 'number' ||
    !Number.isInteger(state.cursor) ||
    state.cursor < 0
  ) {
    return null;
  }
  return {
    candidates: state.candidates as string[],
    discoveredAt: state.discoveredAt,
    cursor: state.cursor,
  };
}

function validNullableTimestamp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

function parseRelayHealth(value: unknown): CachedRelay[] {
  if (!Array.isArray(value)) return [];
  const byUrl = new Map<string, CachedRelay>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const relay = entry as Record<string, unknown>;
    const url =
      typeof relay.url === 'string' ? normalizeRelayUrl(relay.url) : null;
    if (
      !url ||
      typeof relay.lastDiscoveredAt !== 'number' ||
      !Number.isFinite(relay.lastDiscoveredAt) ||
      relay.lastDiscoveredAt < 0 ||
      !validNullableTimestamp(relay.lastCheckedAt) ||
      !validNullableTimestamp(relay.lastSucceededAt) ||
      !validNullableTimestamp(relay.rttMs) ||
      typeof relay.consecutiveFailures !== 'number' ||
      !Number.isInteger(relay.consecutiveFailures) ||
      relay.consecutiveFailures < 0 ||
      typeof relay.supportsControl !== 'boolean' ||
      typeof relay.supportsStorage !== 'boolean'
    ) {
      continue;
    }
    const parsed: CachedRelay = {
      url,
      lastDiscoveredAt: relay.lastDiscoveredAt,
      lastCheckedAt: relay.lastCheckedAt,
      lastSucceededAt: relay.lastSucceededAt,
      rttMs: relay.rttMs,
      consecutiveFailures: relay.consecutiveFailures,
      supportsControl: relay.supportsControl,
      supportsStorage: relay.supportsStorage,
    };
    const previous = byUrl.get(url);
    const freshness = Math.max(
      parsed.lastDiscoveredAt,
      parsed.lastSucceededAt ?? 0,
    );
    const previousFreshness = previous
      ? Math.max(previous.lastDiscoveredAt, previous.lastSucceededAt ?? 0)
      : -1;
    if (freshness >= previousFreshness) byUrl.set(url, parsed);
  }
  return [...byUrl.values()];
}

/** The latest verdict was a pass. */
function isHealthyRelay(relay: CachedRelay): boolean {
  return relay.consecutiveFailures === 0 && relay.lastSucceededAt !== null;
}

/**
 * Whether a cache entry is still worth keeping. A healthy relay is kept for
 * good: it is what a start with dead seeds runs on, and it is probed again
 * before it carries anything, so age costs one probe at most. Only failures
 * and unprobed listings age out.
 */
function isFreshRelay(relay: CachedRelay, now: number): boolean {
  if (isHealthyRelay(relay)) return true;
  const freshness = Math.max(relay.lastDiscoveredAt, relay.lastSucceededAt ?? 0);
  return freshness <= now && now - freshness < RELAY_CANDIDATE_TTL_MS;
}

/** A relay that discovery has named but no probe has judged yet. */
function emptyCachedRelay(url: string, lastDiscoveredAt: number): CachedRelay {
  return {
    url,
    lastDiscoveredAt,
    lastCheckedAt: null,
    lastSucceededAt: null,
    rttMs: null,
    consecutiveFailures: 0,
    supportsControl: false,
    supportsStorage: false,
  };
}

/**
 * Drop expired entries (healthy relays never expire) and order the cache by
 * how much a future transfer wants each relay: proven storage relays first, then fewer failures, then
 * lower latency, then most recently seen. `RELAY_CACHE_MAX_ENTRIES` bounds
 * what is kept, so eviction sheds repeatedly failing relays before ones the
 * background pass has yet to reach.
 */
function rankRelayCache(relays: CachedRelay[], now: number): CachedRelay[] {
  return relays
    .filter((relay) => isFreshRelay(relay, now))
    .sort(
      (a, b) =>
        Number(b.supportsStorage) - Number(a.supportsStorage) ||
        a.consecutiveFailures - b.consecutiveFailures ||
        (a.rttMs ?? Number.POSITIVE_INFINITY) -
          (b.rttMs ?? Number.POSITIVE_INFINITY) ||
        b.lastDiscoveredAt - a.lastDiscoveredAt,
    )
    .slice(0, RELAY_CACHE_MAX_ENTRIES);
}

/** Canonical, deduped, non-null relay URLs. */
export function canonicalUrls(urls: string[]): string[] {
  return [
    ...new Set(
      urls.map(normalizeRelayUrl).filter((url): url is string => url !== null),
    ),
  ];
}

export function createIndexedDbRelayPool(): RelayPoolStorage {
  return {
    async getState() {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_STATE_STORE,
          'readonly',
        );
        const value = await requestResult(
          transaction
            .objectStore(RELAY_CACHE_STATE_STORE)
            .get(RELAY_POOL_STATE_KEY),
        );
        await transactionDone(transaction);
        return parseRelayPoolState(value);
      } catch {
        return null;
      } finally {
        database?.close();
      }
    },
    async setState(state) {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_STATE_STORE,
          'readwrite',
        );
        const candidates = [
          ...new Set(
            state.candidates
              .map(normalizeRelayUrl)
              .filter((url): url is string => url !== null),
          ),
        ];
        transaction
          .objectStore(RELAY_CACHE_STATE_STORE)
          .put({ ...state, candidates }, RELAY_POOL_STATE_KEY);
        await transactionDone(transaction);
      } catch {
        // Cache persistence never prevents a transfer.
      } finally {
        database?.close();
      }
    },
    async getRelayHealth() {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_HEALTH_STORE,
          'readonly',
        );
        const value = await requestResult(
          transaction.objectStore(RELAY_CACHE_HEALTH_STORE).getAll(),
        );
        await transactionDone(transaction);
        return parseRelayHealth(value);
      } catch {
        return [];
      } finally {
        database?.close();
      }
    },
    async setRelayHealth(relays) {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_HEALTH_STORE,
          'readwrite',
        );
        const store = transaction.objectStore(RELAY_CACHE_HEALTH_STORE);
        store.clear();
        const byUrl = new Map<string, CachedRelay>();
        for (const relay of relays) {
          const url = normalizeRelayUrl(relay.url);
          if (url) byUrl.set(url, { ...relay, url });
        }
        for (const relay of byUrl.values()) store.put(relay);
        await transactionDone(transaction);
      } catch {
        // Cache persistence never prevents a transfer.
      } finally {
        database?.close();
      }
    },
  };
}

/**
 * Extract relay URL candidates from NIP-66 (kind 30166, `d` tag) and NIP-65
 * (kind 10002, `r` tags) events. Pure; normalization + dedupe included.
 */
export function parseRelayCandidates(events: Event[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    const raw: string[] = [];
    if (event.kind === KIND_RELAY_DISCOVERY) {
      const d = event.tags.find((t) => t[0] === 'd')?.[1];
      if (d) raw.push(d);
    } else if (event.kind === KIND_RELAY_LIST) {
      for (const tag of event.tags) {
        if (tag[0] === 'r' && tag[1]) raw.push(tag[1]);
      }
    }
    for (const candidate of raw) {
      const normalized = normalizeRelayUrl(candidate);
      if (normalized) seen.add(normalized);
    }
  }
  return [...seen];
}

/**
 * Discover relay candidates from the seed relays via NIP-66/NIP-65 queries.
 * The seeds are only queried, never returned: `DEFAULT_RELAYS` is the
 * signaling pool and must never carry chunks, so a seed named by a discovery
 * event is dropped too, and a failed discovery yields an empty list (the
 * upload then refuses to start) rather than degrading to the seeds.
 */
export async function discoverRelayCandidates(
  pool: NostrFilePool,
  seeds: string[] = [...DEFAULT_RELAYS],
): Promise<string[]> {
  const canonicalSeeds = canonicalUrls(seeds);
  const queries = [
    { kinds: [KIND_RELAY_DISCOVERY], limit: DISCOVERY_CANDIDATE_LIMIT },
    { kinds: [KIND_RELAY_LIST], limit: DISCOVERY_CANDIDATE_LIMIT },
  ];
  const results = await Promise.allSettled(
    queries.map((filter) =>
      pool.querySync(canonicalSeeds, filter, { maxWait: 8000 }),
    ),
  );
  const events = results.flatMap((r) =>
    r.status === 'fulfilled' ? r.value : [],
  );
  const seedSet = new Set(canonicalSeeds);
  return parseRelayCandidates(events)
    .filter((url) => !seedSet.has(url))
    .slice(0, DISCOVERY_CANDIDATE_CAP);
}

/**
 * Enumerate the relay population rather than sampling it: page back through
 * NIP-66 (kind 30166) and NIP-65 (kind 10002) history by `created_at` until a
 * page returns nothing, stops moving, or the page bound is hit. Unlike
 * `discoverRelayCandidates` the result is uncapped — this is the background
 * pass, and its whole job is to find every relay it can.
 *
 * Seeds are queried but never returned; a query that fails ends that kind's
 * paging with whatever it already collected instead of failing the sweep.
 */
export async function discoverAllRelayCandidates(
  pool: NostrFilePool,
  seeds: string[] = [...DEFAULT_RELAYS],
  opts: {
    pageLimit?: number;
    maxPages?: number;
    signal?: AbortSignal;
    isCancelled?: () => boolean;
    onProgress?: (found: number) => void;
    /**
     * Every relay found so far, after each page. A caller that abandons the
     * enumeration mid-page still has what the pages before it turned up.
     */
    onCandidates?: (found: string[]) => void;
  } = {},
): Promise<string[]> {
  const canonicalSeeds = canonicalUrls(seeds);
  const seedSet = new Set(canonicalSeeds);
  const found = new Set<string>();
  const pageLimit = opts.pageLimit ?? DISCOVERY_PAGE_LIMIT;
  const maxPages = opts.maxPages ?? DISCOVERY_MAX_PAGES;
  const stopped = () =>
    opts.signal?.aborted === true || opts.isCancelled?.() === true;

  for (const kind of [KIND_RELAY_DISCOVERY, KIND_RELAY_LIST]) {
    let until: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      if (stopped()) return [...found];
      const filter: Filter = { kinds: [kind], limit: pageLimit };
      if (until !== undefined) filter.until = until;
      let events: Event[];
      try {
        events = await pool.querySync(canonicalSeeds, filter, {
          maxWait: DISCOVERY_PAGE_MAX_WAIT_MS,
        });
      } catch {
        break;
      }
      if (events.length === 0) break;
      for (const url of parseRelayCandidates(events)) {
        if (!seedSet.has(url)) found.add(url);
      }
      opts.onProgress?.(found.size);
      opts.onCandidates?.([...found]);
      // Step the cursor past the oldest event this page returned. A cursor
      // that fails to move means the relays are serving the same page again.
      const oldest = events.reduce(
        (min, event) => Math.min(min, event.created_at),
        Number.POSITIVE_INFINITY,
      );
      if (!Number.isFinite(oldest)) break;
      const next = oldest - 1;
      if (until !== undefined && next >= until) break;
      until = next;
    }
  }
  return [...found];
}

/**
 * Real write->read round trip against a single relay using the production
 * event shape (kind, tags, NIP-40 expiration, full codec, full chunk size)
 * with throwaway keys. Returns the round-trip time, or null if the relay
 * fails any step.
 */
async function probeRelay(
  pool: NostrFilePool,
  url: string,
  timeoutMs: number,
  probeBytes: number,
): Promise<number | null> {
  const started = Date.now();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    const aesKey = await crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    const payload = crypto.getRandomValues(new Uint8Array(probeBytes));
    const aad = chunkAad('probe', 0, 1);
    const content = await encodeChunkContent(aesKey, payload, aad);
    const { secretKey, publicKey } = generateEphemeralKeys();
    const { event, dTag } = buildProbeEvent(secretKey, content);
    wipeBufferSource(secretKey);

    const withTimeout = <T>(p: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('probe timeout')),
            timeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    };

    await withTimeout(Promise.all(pool.publish([url], event)));
    const events = await withTimeout(
      pool.querySync(
        [url],
        {
          kinds: [EVENT_KIND_FILE_CHUNK],
          authors: [publicKey],
          '#d': [dTag],
          limit: 1,
        },
        { maxWait: timeoutMs },
      ),
    );
    const fetched = events[0];
    if (!fetched || fetched.content !== content) return null;
    const roundTripped = await decodeChunkContent(aesKey, fetched.content, aad);
    if (roundTripped.length !== payload.length) return null;
    for (let i = 0; i < payload.length; i++) {
      if (roundTripped[i] !== payload[i]) return null;
    }
    return Date.now() - started;
  } catch {
    return null;
  } finally {
    wipeBufferSource(keyBytes);
  }
}

/**
 * Health-check candidates with bounded concurrency; early-stops once
 * targetCount relays pass. Results are sorted fastest-first.
 */
export async function healthCheckRelays(
  pool: NostrFilePool,
  candidates: string[],
  opts: {
    concurrency?: number;
    timeoutMs?: number;
    targetCount?: number;
    probeBytes?: number;
    isCancelled?: () => boolean;
    onProgress?: (
      checked: number,
      healthy: number,
      url: string,
      rttMs: number | null,
    ) => void;
  } = {},
): Promise<HealthyRelay[]> {
  const concurrency = opts.concurrency ?? HEALTH_CHECK_CONCURRENCY;
  const timeoutMs = opts.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const targetCount = opts.targetCount ?? HEALTH_CHECK_TARGET_COUNT;
  const probeBytes = opts.probeBytes ?? HEALTH_CHECK_PROBE_BYTES;

  const healthy: HealthyRelay[] = [];
  let nextIndex = 0;
  let checked = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (opts.isCancelled?.()) return;
      if (healthy.length >= targetCount) return;
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const url = candidates[index];
      const rttMs = await probeRelay(pool, url, timeoutMs, probeBytes);
      checked++;
      // Re-check the target: sibling probes may have filled it in flight.
      if (rttMs !== null && healthy.length < targetCount) {
        healthy.push({ url, rttMs });
      } else {
        // Failed the probe, or passed after the target filled: this relay
        // will not be used, so stop its socket (and its reconnect loop) now.
        pool.close?.([url]);
      }
      opts.onProgress?.(checked, healthy.length, url, rttMs);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
  );

  return healthy.sort((a, b) => a.rttMs - b.rttMs);
}

/**
 * Record relays discovery has named, without probing them. The sweep normally
 * finds far more relays than one transfer lasts long enough to probe, so the
 * enumeration is written down first and the verdicts fill in behind it —
 * otherwise everything past the last probe would be lost at teardown.
 */
export async function saveDiscoveredRelays(
  storage: RelayPoolStorage,
  urls: string[],
  now: number = Date.now(),
): Promise<void> {
  const canonical = canonicalUrls(urls);
  if (canonical.length === 0) return;
  const byUrl = new Map<string, CachedRelay>();
  for (const relay of await storage.getRelayHealth()) {
    const url = normalizeRelayUrl(relay.url);
    if (url) byUrl.set(url, { ...relay, url });
  }
  for (const url of canonical) {
    const previous = byUrl.get(url);
    byUrl.set(
      url,
      previous
        ? { ...previous, lastDiscoveredAt: now }
        : emptyCachedRelay(url, now),
    );
  }
  await storage.setRelayHealth(rankRelayCache([...byUrl.values()], now));
}

/**
 * The background relay pass, run behind a live transfer.
 *
 * The foreground path samples: one page of discovery, capped at
 * DISCOVERY_CANDIDATE_CAP, health-checked only until the ring is full. This
 * does the opposite — it enumerates the whole relay population with
 * `discoverAllRelayCandidates` (uncapped), writes the enumeration to the
 * cache immediately, and then probes it, so what the next transfer knows
 * about is not limited to what this one happened to need.
 *
 * Probe order puts never-checked relays first and otherwise the
 * longest-unchecked first, so successive sessions extend coverage instead of
 * re-probing the same prefix. Sockets are closed as each probe finishes,
 * results are written in batches, and nothing here throws.
 *
 * `signal` ends the sweep at once: probes still in flight are abandoned and
 * their results discarded rather than waited out, so a caller about to
 * destroy the pool never blocks on a probe timeout.
 */
export async function sweepRelayHealth(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  opts: {
    /** Candidates the foreground health check early-stopped before reaching. */
    unprobed?: string[];
    /** Relays carrying this transfer. Never probed, never closed. */
    excludeRelays?: string[];
    seeds?: string[];
    concurrency?: number;
    timeoutMs?: number;
    probeBytes?: number;
    saveBatch?: number;
    signal?: AbortSignal;
    isCancelled?: () => boolean;
    onProgress?: (checked: number, healthy: number, total: number) => void;
  } = {},
): Promise<void> {
  const concurrency = opts.concurrency ?? BACKGROUND_PROBE_CONCURRENCY;
  const timeoutMs = opts.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const probeBytes = opts.probeBytes ?? HEALTH_CHECK_PROBE_BYTES;
  const sweepCapability: RelayCapability =
    probeBytes >= HEALTH_CHECK_PROBE_BYTES ? 'storage' : 'control';
  const saveBatch = opts.saveBatch ?? BACKGROUND_PROBE_SAVE_BATCH;
  const stopped = () =>
    opts.signal?.aborted === true || opts.isCancelled?.() === true;
  const seeds = canonicalUrls(opts.seeds ?? [...DEFAULT_RELAYS]);
  const transferRelays = canonicalUrls(opts.excludeRelays ?? []);
  // Signaling relays are chosen for small messages and must never carry
  // chunks, so they stay out of the sweep exactly as they stay out of a ring.
  const excluded = new Set([...transferRelays, ...seeds]);

  const aborted = new Promise<void>((resolve) => {
    const signal = opts.signal;
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

  // Discovery only polls the abort flag between pages, and a page can sit on
  // querySync for DISCOVERY_PAGE_MAX_WAIT_MS. Racing the signal means a caller
  // about to destroy the pool is not held up by an in-flight page; the
  // abandoned query settles into nothing.
  // What the pages so far turned up, kept outside the discovery promise: an
  // abort that wins the race below abandons that promise mid-page, and the
  // relays it had already enumerated must not go with it.
  let partial: string[] = [];
  const raced = await Promise.race([
    discoverAllRelayCandidates(pool, seeds, {
      signal: opts.signal,
      isCancelled: opts.isCancelled,
      onCandidates: (found) => {
        partial = found;
      },
    }).catch(() => [] as string[]),
    aborted.then(() => null),
  ]);
  const discovered = raced ?? partial;
  // Discovery reopened the seeds; the ones not carrying this transfer are
  // done again. Not on an abort, whose caller is about to destroy the pool.
  if (raced !== null) {
    const doneSeeds = seeds.filter((url) => !transferRelays.includes(url));
    if (doneSeeds.length > 0) pool.close?.(doneSeeds);
  }

  const urls = canonicalUrls([...(opts.unprobed ?? []), ...discovered]).filter(
    (url) => !excluded.has(url),
  );
  if (urls.length === 0) return;
  // Written down before a single probe runs, and before a stop is honoured:
  // the enumeration is the part the next transfer needs most, and it must
  // survive a teardown that lands long before the probing is done — or
  // during the discovery itself.
  await saveDiscoveredRelays(storage, urls).catch(() => {});
  if (stopped()) return;

  // Longest-unchecked first, so a second session picks up where this one ran
  // out of transfer rather than re-probing the same relays.
  const lastCheckedAt = new Map<string, number>();
  for (const relay of await storage.getRelayHealth().catch(() => [])) {
    const url = normalizeRelayUrl(relay.url);
    if (url && relay.lastCheckedAt !== null) {
      lastCheckedAt.set(url, relay.lastCheckedAt);
    }
  }
  const queue = [...urls].sort(
    (a, b) =>
      (lastCheckedAt.get(a) ?? -1) - (lastCheckedAt.get(b) ?? -1) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  if (stopped()) return;

  let nextIndex = 0;
  let checked = 0;
  let healthyCount = 0;
  let healthy: HealthyRelay[] = [];
  let failed: string[] = [];
  // Each save is a read-modify-write of the whole health store, so batches are
  // chained instead of run concurrently.
  let saving = Promise.resolve();

  const flush = (): Promise<void> => {
    if (healthy.length === 0 && failed.length === 0) return saving;
    const batchHealthy = healthy;
    const batchFailed = failed;
    healthy = [];
    failed = [];
    saving = saving.then(() =>
      saveRelayHealth(storage, batchHealthy, batchFailed, {
        capability: sweepCapability,
      }).catch(() => {}),
    );
    return saving;
  };

  const worker = async (): Promise<void> => {
    while (!stopped()) {
      const index = nextIndex++;
      if (index >= queue.length) return;
      const url = queue[index];
      const rttMs = await probeRelay(pool, url, timeoutMs, probeBytes);
      // A probe that outlived the stop raced the caller tearing the pool
      // down; its verdict says nothing about the relay.
      if (stopped()) return;
      checked++;
      if (rttMs === null) failed.push(url);
      else {
        healthy.push({ url, rttMs });
        healthyCount++;
      }
      pool.close?.([url]);
      opts.onProgress?.(checked, healthyCount, queue.length);
      if (healthy.length + failed.length >= saveBatch) flush();
    }
  };

  const workers = Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  ).catch(() => {});
  await Promise.race([workers, aborted]);
  await flush();
}

/**
 * Pick the relay batch for this upload via a persisted rotating cursor over
 * the healthy list (load balancing across uploads). Returns up to `count`
 * relays.
 */
export async function selectUploadRelays(
  healthy: HealthyRelay[],
  count: number,
  storage: RelayPoolStorage,
): Promise<string[]> {
  if (healthy.length === 0) return [];
  const state = await storage.getState();
  const cursor = state ? state.cursor % healthy.length : 0;
  const selected: string[] = [];
  for (let i = 0; i < Math.min(count, healthy.length); i++) {
    selected.push(healthy[(cursor + i) % healthy.length].url);
  }
  await storage.setState({
    candidates: state?.candidates ?? [],
    discoveredAt: state?.discoveredAt ?? 0,
    cursor: (cursor + selected.length) % healthy.length,
  });
  return selected;
}

/**
 * Candidate list with seven-day caching. Every run merges fresh discovery results
 * into the still-valid candidate and relay-health caches, so newly listed
 * relays become available without giving up cached fallbacks when discovery
 * is sparse or the default seeds are unreliable.
 *
 * The seeds are never returned, from any source — discovery, the candidate
 * cache, or the relay-health cache. Signaling relays are chosen for small
 * messages and must never end up carrying chunks.
 */
export async function getRelayCandidates(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  opts: {
    capability?: RelayCapability;
    now?: number;
    /** Signaling seeds to discover from; queried, never returned. */
    seeds?: string[];
  } = {},
): Promise<string[]> {
  const capability = opts.capability ?? 'storage';
  const now = opts.now ?? Date.now();
  const [state, savedRelayHealth] = await Promise.all([
    storage.getState(),
    storage.getRelayHealth(),
  ]);
  const byUrl = new Map(
    savedRelayHealth
      .filter((relay) => isFreshRelay(relay, now))
      .map((relay) => [relay.url, relay]),
  );
  // Discovery drops seeds from what it returns, but the caches are older than
  // any given seed list: a relay listed as a candidate before it became a
  // signaling seed, or left behind by a seed list that has since changed, is
  // still sitting in them. Barring seeds here too is what makes `merged` —
  // which is written straight back to the candidate cache — self-healing
  // rather than carrying such an entry forever.
  const seeds = canonicalUrls(opts.seeds ?? [...DEFAULT_RELAYS]);
  const seedSet = new Set(seeds);
  const cachedCandidates =
    state &&
    state.discoveredAt <= now &&
    now - state.discoveredAt < RELAY_CANDIDATE_TTL_MS
      ? state.candidates
          .map((url) => normalizeRelayUrl(url))
          .filter((url): url is string => url !== null && !seedSet.has(url))
      : [];
  const discovered = await discoverRelayCandidates(pool, seeds);
  for (const url of cachedCandidates) {
    if (!byUrl.has(url)) {
      byUrl.set(url, emptyCachedRelay(url, state?.discoveredAt ?? 0));
    }
  }
  for (const url of discovered) {
    const relay = byUrl.get(url) ?? emptyCachedRelay(url, now);
    byUrl.set(url, { ...relay, lastDiscoveredAt: now });
  }
  const knownWorking = [...byUrl.values()]
    .filter(
      (relay) =>
        !seedSet.has(relay.url) &&
        (capability === 'storage'
          ? relay.supportsStorage
          : relay.supportsControl) &&
        isHealthyRelay(relay),
    )
    .sort(
      (a, b) =>
        (a.rttMs ?? Number.POSITIVE_INFINITY) -
          (b.rttMs ?? Number.POSITIVE_INFINITY) ||
        (b.lastSucceededAt ?? 0) - (a.lastSucceededAt ?? 0),
    )
    .map((relay) => relay.url);
  const rankedCandidates = [
    ...new Set([...discovered, ...cachedCandidates]),
  ].sort((a, b) => {
    const relayA = byUrl.get(a);
    const relayB = byUrl.get(b);
    return (
      (relayA?.consecutiveFailures ?? 0) - (relayB?.consecutiveFailures ?? 0) ||
      (relayB?.lastDiscoveredAt ?? 0) - (relayA?.lastDiscoveredAt ?? 0)
    );
  });
  // Recently proven low-latency relays stay first so a seed outage can fall
  // back to them. Remaining candidates are failure-ranked, then newest-first.
  const merged = [...new Set([...knownWorking, ...rankedCandidates])].slice(
    0,
    DISCOVERY_CANDIDATE_CAP,
  );
  await Promise.all([
    storage.setState({
      candidates: merged,
      discoveredAt: now,
      cursor: state?.cursor ?? 0,
    }),
    // The whole cache is written back, not just `merged`. Trimming it to this
    // transfer's working set would throw away everything the background pass
    // enumerated beyond the 150 relays this run happens to rank highest.
    storage.setRelayHealth(rankRelayCache([...byUrl.values()], now)),
  ]);
  return merged;
}

/**
 * Persist discovery and probe history under the capability the probe actually
 * proved. A full-size success proves both capabilities; a control-sized
 * success proves only the small write and leaves any earlier full-size
 * verdict alone, since 256 bytes says nothing either way about a chunk. A
 * failure at either size clears both flags but retains bounded failure
 * history for candidate ranking.
 */
export async function saveRelayHealth(
  storage: RelayPoolStorage,
  healthy: HealthyRelay[],
  failedRelays: string[],
  opts: { capability: RelayCapability; now?: number },
): Promise<void> {
  const { capability } = opts;
  const now = opts.now ?? Date.now();
  const previous = await storage.getRelayHealth();
  const failed = new Set(
    failedRelays
      .map((url) => normalizeRelayUrl(url))
      .filter((url): url is string => url !== null),
  );
  const healthyByUrl = new Map<string, number>();
  for (const relay of healthy) {
    const url = normalizeRelayUrl(relay.url);
    if (url) {
      healthyByUrl.set(
        url,
        Math.min(
          healthyByUrl.get(url) ?? Number.POSITIVE_INFINITY,
          relay.rttMs,
        ),
      );
    }
  }
  const probed = new Set([...failed, ...healthyByUrl.keys()]);
  const byUrl = new Map<string, CachedRelay>();
  for (const relay of previous) {
    const url = normalizeRelayUrl(relay.url);
    if (url) byUrl.set(url, { ...relay, url });
  }
  for (const url of probed) {
    const previousRelay = byUrl.get(url);
    const relay: CachedRelay = previousRelay ?? emptyCachedRelay(url, now);
    const rttMs = healthyByUrl.get(url);
    byUrl.set(
      url,
      rttMs === undefined
        ? {
            ...relay,
            lastCheckedAt: now,
            rttMs: null,
            consecutiveFailures: relay.consecutiveFailures + 1,
            supportsControl: false,
            supportsStorage: false,
          }
        : {
            ...relay,
            lastCheckedAt: now,
            lastSucceededAt: now,
            rttMs,
            consecutiveFailures: 0,
            supportsControl: true,
            supportsStorage:
              capability === 'storage' ? true : relay.supportsStorage,
          },
    );
  }
  await storage.setRelayHealth(rankRelayCache([...byUrl.values()], now));
}
