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
  RELAY_CANDIDATE_TTL_MS,
  RELAY_POOL_STORAGE_KEY,
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

/** Injected persistence so node tests never touch localStorage. */
export interface RelayPoolStorage {
  get(): RelayPoolState | null;
  set(state: RelayPoolState): void;
}

export function createLocalStorageRelayPool(): RelayPoolStorage {
  return {
    get() {
      try {
        const raw = localStorage.getItem(RELAY_POOL_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') return null;
        const s = parsed as Record<string, unknown>;
        if (
          !Array.isArray(s.candidates) ||
          !s.candidates.every((c) => typeof c === 'string') ||
          typeof s.discoveredAt !== 'number' ||
          typeof s.cursor !== 'number' ||
          !Number.isInteger(s.cursor) ||
          s.cursor < 0
        ) {
          return null;
        }
        return {
          candidates: s.candidates as string[],
          discoveredAt: s.discoveredAt,
          cursor: s.cursor,
        };
      } catch {
        return null;
      }
    },
    set(state) {
      try {
        localStorage.setItem(RELAY_POOL_STORAGE_KEY, JSON.stringify(state));
      } catch {
        // Quota/private-mode failures degrade to per-session rotation.
      }
    },
  };
}

function normalizeRelayUrl(raw: string): string | null {
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
    host.endsWith('.local')
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
 * The seeds themselves are always part of the result — discovery failure
 * degrades to the default relay list, never to nothing.
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
  const discovered = parseRelayCandidates(events);
  const seedSet = seeds
    .map((s) => normalizeRelayUrl(s))
    .filter((s): s is string => s !== null);
  // Seeds first so health-check early-stop favors known-good relays.
  const merged = [...new Set([...seedSet, ...discovered])];
  return merged.slice(0, DISCOVERY_CANDIDATE_CAP);
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
    const payload = crypto.getRandomValues(
      new Uint8Array(HEALTH_CHECK_PROBE_BYTES),
    );
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
    isCancelled?: () => boolean;
    onProgress?: (checked: number, healthy: number) => void;
  } = {},
): Promise<HealthyRelay[]> {
  const concurrency = opts.concurrency ?? HEALTH_CHECK_CONCURRENCY;
  const timeoutMs = opts.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
  const targetCount = opts.targetCount ?? HEALTH_CHECK_TARGET_COUNT;

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
      const rttMs = await probeRelay(pool, url, timeoutMs);
      checked++;
      // Re-check the target: sibling probes may have filled it in flight.
      if (rttMs !== null && healthy.length < targetCount) {
        healthy.push({ url, rttMs });
      }
      opts.onProgress?.(checked, healthy.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
  );

  return healthy.sort((a, b) => a.rttMs - b.rttMs);
}

/**
 * Pick the relay batch for this upload via a persisted rotating cursor over
 * the healthy list (load balancing across uploads, like nostrsave's SQLite
 * cursor). Returns up to `count` relays.
 */
export function selectUploadRelays(
  healthy: HealthyRelay[],
  count: number,
  storage: RelayPoolStorage,
): string[] {
  if (healthy.length === 0) return [];
  const state = storage.get();
  const cursor = state ? state.cursor % healthy.length : 0;
  const selected: string[] = [];
  for (let i = 0; i < Math.min(count, healthy.length); i++) {
    selected.push(healthy[(cursor + i) % healthy.length].url);
  }
  storage.set({
    candidates: state?.candidates ?? [],
    discoveredAt: state?.discoveredAt ?? 0,
    cursor: (cursor + selected.length) % healthy.length,
  });
  return selected;
}

/**
 * Candidate list with 24h caching: reuse stored candidates when fresh,
 * otherwise run discovery and persist the result (cursor preserved).
 */
export async function getRelayCandidates(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  now: number = Date.now(),
): Promise<string[]> {
  const state = storage.get();
  if (
    state &&
    state.candidates.length > 0 &&
    now - state.discoveredAt < RELAY_CANDIDATE_TTL_MS
  ) {
    return state.candidates;
  }
  const candidates = await discoverRelayCandidates(pool);
  storage.set({
    candidates,
    discoveredAt: now,
    cursor: state?.cursor ?? 0,
  });
  return candidates;
}
