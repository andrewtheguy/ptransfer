import type { Event } from 'nostr-tools';
import { DEFAULT_RELAYS } from '../nostr/relays';
import {
  CONTROL_PROBE_BYTES,
  CONTROL_PROBE_TIMEOUT_MS,
  CONTROL_RELAY_COUNT,
  MIN_CONTROL_RELAYS,
  MIN_UPLOAD_RELAYS,
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_BACKOFF_CAP_MS,
  PUBLISH_BACKOFF_JITTER_MS,
  PUBLISH_MAX_RETRIES,
  UPLOAD_RELAY_COUNT,
} from './constants';
import type { NostrFilePool } from './pool';
import {
  getRelayCandidates,
  healthCheckRelays,
  normalizeRelayUrl,
  type RelayPoolStorage,
  selectUploadRelays,
} from './relay-pool';
import { type NostrFileTransferStats, relayStatsFor } from './stats';

export class NostrFileCancelledError extends Error {
  constructor() {
    super('Transfer cancelled');
    this.name = 'NostrFileCancelledError';
  }
}

export interface UploadProgress {
  phase: 'hashing' | 'discovering' | 'health_check';
  relaysChecked?: number;
  relaysHealthy?: number;
  /** Running totals for the whole transfer; one object, mutated in place. */
  stats: NostrFileTransferStats;
}

function backoffDelay(attempt: number): number {
  return (
    Math.min(PUBLISH_BACKOFF_BASE_MS * 2 ** attempt, PUBLISH_BACKOFF_CAP_MS) +
    Math.random() * PUBLISH_BACKOFF_JITTER_MS
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Publish one event to one relay with retries. Returns true when the relay
 * acknowledged the event. Attempts, acceptances, failures, and accepted
 * content bytes are tallied into `stats` (whole-transfer and per-relay).
 */
export async function publishWithRetry(
  pool: NostrFilePool,
  relay: string,
  event: Event,
  isCancelled: () => boolean,
  stats: NostrFileTransferStats,
): Promise<boolean> {
  const relayStats = relayStatsFor(stats, relay, 'storage');
  for (let attempt = 0; attempt <= PUBLISH_MAX_RETRIES; attempt++) {
    if (isCancelled()) return false;
    stats.publishAttempts++;
    relayStats.publishAttempts++;
    try {
      await Promise.all(pool.publish([relay], event));
      stats.eventsPublished++;
      stats.bytesPublished += event.content.length;
      relayStats.eventsAccepted++;
      relayStats.bytesUp += event.content.length;
      return true;
    } catch {
      if (attempt < PUBLISH_MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
      }
    }
  }
  stats.publishesFailed++;
  relayStats.publishesFailed++;
  return false;
}

export const NOT_ENOUGH_RELAYS_MESSAGE =
  'Not enough working Nostr relays found. Try again, or use the normal Manual Exchange transfer.';

/**
 * The control relays for a transfer: the caller's override, or the fastest
 * DEFAULT_RELAYS seeds that pass a small-event probe (with read-back, so the
 * stored control backlog is actually served). Runs before the code is handed
 * out, so it stays quick — no discovery, no rotation cursor. Throws when
 * fewer than MIN_CONTROL_RELAYS relays are usable.
 */
export async function resolveControlRelays(
  pool: NostrFilePool,
  opts: {
    controlRelayOverride?: string[];
    isCancelled: () => boolean;
    onProgress: (checked: number, healthy: number) => void;
    stats: NostrFileTransferStats;
  },
): Promise<string[]> {
  const { stats } = opts;
  const seedStats = (relays: string[]) => {
    for (const relay of relays) relayStatsFor(stats, relay, 'control');
    return relays;
  };
  if (opts.controlRelayOverride && opts.controlRelayOverride.length > 0) {
    const distinct = [
      ...new Set(
        opts.controlRelayOverride.map((url) => normalizeRelayUrl(url) ?? url),
      ),
    ];
    if (distinct.length < MIN_CONTROL_RELAYS) {
      throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
    }
    return seedStats(distinct);
  }
  const probeStarted = Date.now();
  const healthy = await healthCheckRelays(pool, [...DEFAULT_RELAYS], {
    probeBytes: CONTROL_PROBE_BYTES,
    timeoutMs: CONTROL_PROBE_TIMEOUT_MS,
    targetCount: CONTROL_RELAY_COUNT,
    isCancelled: opts.isCancelled,
    onProgress: opts.onProgress,
  });
  stats.phaseMs.controlProbe = Date.now() - probeStarted;
  if (opts.isCancelled()) throw new NostrFileCancelledError();
  if (healthy.length < MIN_CONTROL_RELAYS) {
    throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
  }
  const relays = healthy.slice(0, CONTROL_RELAY_COUNT).map((r) => r.url);
  const passedOver = healthy.slice(CONTROL_RELAY_COUNT).map((r) => r.url);
  if (passedOver.length > 0) pool.close?.(passedOver);
  seedStats(relays);
  for (const { url, rttMs } of healthy) {
    const entry = stats.relays.find((r) => r.url === url);
    if (entry) entry.rttMs = rttMs;
  }
  return relays;
}

/**
 * The relay ring for an upload: the caller's override, or discovery +
 * health check + rotating batch selection. Relays in `excludeRelays` (the
 * transfer's control relays) and the whole DEFAULT_RELAYS signaling pool
 * never join the ring, whichever path picks it — signaling relays are chosen
 * for small messages, not 32 KiB chunks, and chunk traffic must not compete
 * with the control channel. Throws when fewer than MIN_UPLOAD_RELAYS relays
 * are usable.
 */
export async function resolveUploadRelays(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  opts: {
    relayOverride?: string[];
    excludeRelays: string[];
    isCancelled: () => boolean;
    onProgress: (p: UploadProgress) => void;
    stats: NostrFileTransferStats;
  },
): Promise<string[]> {
  const { isCancelled, onProgress, stats } = opts;
  const throwIfCancelled = () => {
    if (isCancelled()) throw new NostrFileCancelledError();
  };
  const seedRing = (relays: string[]) => {
    for (const relay of relays) relayStatsFor(stats, relay, 'storage');
    return relays;
  };
  // DEFAULT_RELAYS is also filtered here (not just in discovery) so a stale
  // candidate cache written before seeds were barred cannot resurface them.
  const excluded = new Set(
    [...opts.excludeRelays, ...DEFAULT_RELAYS].map(
      (url) => normalizeRelayUrl(url) ?? url,
    ),
  );
  const isExcluded = (url: string) =>
    excluded.has(normalizeRelayUrl(url) ?? url);
  if (opts.relayOverride && opts.relayOverride.length > 0) {
    const usable = [
      ...new Set(
        opts.relayOverride.map((url) => normalizeRelayUrl(url) ?? url),
      ),
    ].filter((url) => !isExcluded(url));
    if (usable.length < MIN_UPLOAD_RELAYS) {
      throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
    }
    return seedRing(usable);
  }
  onProgress({ phase: 'discovering', stats });
  const discoverStarted = Date.now();
  const candidates = (await getRelayCandidates(pool, storage)).filter(
    (url) => !isExcluded(url),
  );
  stats.candidates = candidates.length;
  stats.phaseMs.discover = Date.now() - discoverStarted;
  // Discovery connected to the seeds; the ones not carrying this transfer's
  // control channel have no further job — stop their sockets.
  const controlSet = new Set(
    opts.excludeRelays.map((url) => normalizeRelayUrl(url) ?? url),
  );
  const doneSeeds = DEFAULT_RELAYS.filter((url) => !controlSet.has(url));
  if (doneSeeds.length > 0) pool.close?.(doneSeeds);
  throwIfCancelled();
  const healthCheckStarted = Date.now();
  const healthy = await healthCheckRelays(pool, candidates, {
    isCancelled,
    onProgress: (relaysChecked, relaysHealthy) => {
      stats.relaysChecked = relaysChecked;
      stats.relaysHealthy = relaysHealthy;
      onProgress({
        phase: 'health_check',
        relaysChecked,
        relaysHealthy,
        stats,
      });
    },
  });
  stats.phaseMs.healthCheck = Date.now() - healthCheckStarted;
  throwIfCancelled();
  if (healthy.length < MIN_UPLOAD_RELAYS) {
    throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
  }
  const relays = selectUploadRelays(healthy, UPLOAD_RELAY_COUNT, storage);
  const ringSet = new Set(relays);
  const unselected = healthy
    .filter((r) => !ringSet.has(r.url))
    .map((r) => r.url);
  if (unselected.length > 0) pool.close?.(unselected);
  seedRing(relays);
  for (const { url, rttMs } of healthy) {
    const entry = stats.relays.find((r) => r.url === url);
    if (entry) entry.rttMs = rttMs;
  }
  return relays;
}
