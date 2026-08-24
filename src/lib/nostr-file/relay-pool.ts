import type { Event } from 'nostr-tools';
import { wipeBufferSource } from '../crypto/memory';
import { generateEphemeralKeys } from '../nostr/events';
import { DEFAULT_RELAYS } from '../nostr/relays';
import { chunkAad, decodeChunkContent, encodeChunkContent } from './codec';
import {
  DISCOVERY_CANDIDATE_CAP,
  DISCOVERY_CANDIDATE_LIMIT,
  EVENT_KIND_FILE_CHUNK,
  HEALTH_CHECK_CONCURRENCY,
  HEALTH_CHECK_PROBE_BYTES,
  HEALTH_CHECK_TARGET_COUNT,
  HEALTH_CHECK_TIMEOUT_MS,
  RELAY_CACHE_DATABASE_NAME,
  RELAY_CACHE_DATABASE_VERSION,
  RELAY_CACHE_STATE_STORE,
  RELAY_CACHE_WORKING_STORE,
  RELAY_CANDIDATE_TTL_MS,
} from './constants';
import { buildProbeEvent } from './events';
import type { NostrFilePool } from './pool';

// NIP-66 relay discovery events and NIP-65 relay list metadata.
const KIND_RELAY_DISCOVERY = 30166;
const KIND_RELAY_LIST = 10002;

export interface HealthyRelay {
  url: string;
  rttMs: number;
}

export interface RelayPoolState {
  candidates: string[];
  discoveredAt: number;
  cursor: number;
}

export interface KnownWorkingRelay {
  url: string;
  lastSavedAt: number;
}

/** Injected persistence so node tests never touch IndexedDB. */
export interface RelayPoolStorage {
  getState(): Promise<RelayPoolState | null>;
  setState(state: RelayPoolState): Promise<void>;
  getWorkingRelays(): Promise<KnownWorkingRelay[]>;
  setWorkingRelays(relays: KnownWorkingRelay[]): Promise<void>;
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
      database.createObjectStore(RELAY_CACHE_WORKING_STORE, {
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

function parseWorkingRelays(value: unknown): KnownWorkingRelay[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const relay = entry as Record<string, unknown>;
    if (
      typeof relay.url !== 'string' ||
      typeof relay.lastSavedAt !== 'number' ||
      !Number.isFinite(relay.lastSavedAt) ||
      relay.lastSavedAt < 0
    ) {
      return [];
    }
    return [{ url: relay.url, lastSavedAt: relay.lastSavedAt }];
  });
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
        transaction
          .objectStore(RELAY_CACHE_STATE_STORE)
          .put(state, RELAY_POOL_STATE_KEY);
        await transactionDone(transaction);
      } catch {
        // Cache persistence never prevents a transfer.
      } finally {
        database?.close();
      }
    },
    async getWorkingRelays() {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_WORKING_STORE,
          'readonly',
        );
        const value = await requestResult(
          transaction.objectStore(RELAY_CACHE_WORKING_STORE).getAll(),
        );
        await transactionDone(transaction);
        return parseWorkingRelays(value);
      } catch {
        return [];
      } finally {
        database?.close();
      }
    },
    async setWorkingRelays(relays) {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_WORKING_STORE,
          'readwrite',
        );
        const store = transaction.objectStore(RELAY_CACHE_WORKING_STORE);
        store.clear();
        for (const relay of relays) store.put(relay);
        await transactionDone(transaction);
      } catch {
        // Cache persistence never prevents a transfer.
      } finally {
        database?.close();
      }
    },
  };
}

// RFC 2606/6761 names that never resolve on the public internet — a listed
// "relay" there is placeholder junk. `.example` (TLD) stays usable: it is
// this codebase's own test-fixture convention and never appears in the wild.
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLDS = ['.test', '.invalid'];

export function normalizeRelayUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'wss:') return null;
  const host = url.hostname;
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.onion') ||
    host.endsWith('.local') ||
    RESERVED_TLDS.some((tld) => host.endsWith(tld)) ||
    RESERVED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
  ) {
    return null;
  }
  // Drop IP literals (typically private/test relays not reachable for peers).
  if (/^[\d.]+$/.test(host) || host.includes(':')) return null;
  if (url.username || url.password) return null;
  const normalized = `wss://${host}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  return normalized.replace(/\/+$/, '');
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
  const queries = [
    { kinds: [KIND_RELAY_DISCOVERY], limit: DISCOVERY_CANDIDATE_LIMIT },
    { kinds: [KIND_RELAY_LIST], limit: DISCOVERY_CANDIDATE_LIMIT },
  ];
  const results = await Promise.allSettled(
    queries.map((filter) => pool.querySync(seeds, filter, { maxWait: 8000 })),
  );
  const events = results.flatMap((r) =>
    r.status === 'fulfilled' ? r.value : [],
  );
  const seedSet = new Set(seeds.map((s) => normalizeRelayUrl(s) ?? s));
  return parseRelayCandidates(events)
    .filter((url) => !seedSet.has(url))
    .slice(0, DISCOVERY_CANDIDATE_CAP);
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
    onProgress?: (checked: number, healthy: number, url: string) => void;
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
      opts.onProgress?.(checked, healthy.length, url);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
  );

  return healthy.sort((a, b) => a.rttMs - b.rttMs);
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
 * Candidate list with 24h caching. Every run merges fresh discovery results
 * into the still-valid candidate and known-working caches, so newly listed
 * relays become available without giving up cached fallbacks when discovery
 * is sparse or the default seeds are unreliable.
 */
export async function getRelayCandidates(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  now: number = Date.now(),
): Promise<string[]> {
  const [state, savedWorkingRelays] = await Promise.all([
    storage.getState(),
    storage.getWorkingRelays(),
  ]);
  const knownWorking = savedWorkingRelays
    .filter(
      (relay) =>
        relay.lastSavedAt <= now &&
        now - relay.lastSavedAt < RELAY_CANDIDATE_TTL_MS,
    )
    .sort((a, b) => b.lastSavedAt - a.lastSavedAt)
    .map((relay) => normalizeRelayUrl(relay.url))
    .filter((url): url is string => url !== null);
  const cachedCandidates =
    state &&
    state.discoveredAt <= now &&
    now - state.discoveredAt < RELAY_CANDIDATE_TTL_MS
      ? state.candidates
          .map((url) => normalizeRelayUrl(url))
          .filter((url): url is string => url !== null)
      : [];
  const discovered = await discoverRelayCandidates(pool);
  // Known-working relays stay first so a seed outage can fall back to relays
  // already proven by a recent transfer. Fresh discoveries precede the rest
  // of the generic cache, ensuring the merged list keeps evolving.
  const merged = [
    ...new Set([...knownWorking, ...discovered, ...cachedCandidates]),
  ].slice(0, DISCOVERY_CANDIDATE_CAP);
  await storage.setState({
    candidates: merged,
    discoveredAt: now,
    cursor: state?.cursor ?? 0,
  });
  return merged;
}

/**
 * Persist recent health-check passes and remove saved relays that just failed.
 * Saved relays not probed in this run remain available until their TTL ends.
 */
export async function saveWorkingRelays(
  storage: RelayPoolStorage,
  healthy: HealthyRelay[],
  probedCandidates: string[],
  now: number = Date.now(),
): Promise<void> {
  const previous = await storage.getWorkingRelays();
  const probed = new Set(
    probedCandidates
      .map((url) => normalizeRelayUrl(url))
      .filter((url): url is string => url !== null),
  );
  const healthyUrls = new Set(
    healthy
      .map((relay) => normalizeRelayUrl(relay.url))
      .filter((url): url is string => url !== null),
  );
  const byUrl = new Map<string, KnownWorkingRelay>();
  for (const relay of previous) {
    const url = normalizeRelayUrl(relay.url);
    if (
      url &&
      (!probed.has(url) || healthyUrls.has(url)) &&
      relay.lastSavedAt <= now &&
      now - relay.lastSavedAt < RELAY_CANDIDATE_TTL_MS
    ) {
      byUrl.set(url, { url, lastSavedAt: relay.lastSavedAt });
    }
  }
  for (const relay of healthy) {
    const url = normalizeRelayUrl(relay.url);
    if (url) byUrl.set(url, { url, lastSavedAt: now });
  }
  const saved = [...byUrl.values()]
    .sort((a, b) => b.lastSavedAt - a.lastSavedAt)
    .slice(0, DISCOVERY_CANDIDATE_CAP);
  await storage.setWorkingRelays(saved);
}
