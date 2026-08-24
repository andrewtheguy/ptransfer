import type { Event } from 'nostr-tools';
import { DEFAULT_RELAYS, normalizeRelayUrl } from '../nostr/relays';
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
  SIGNALING_RESERVE_RELAY_COUNT,
  UPLOAD_RELAY_COUNT,
} from './constants';
import type { NostrFilePool } from './pool';
import {
  getRelayCandidates,
  type HealthyRelay,
  healthCheckRelays,
  type RelayPoolStorage,
  saveRelayHealth,
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

export interface UploadRelaySelection {
  storageRelays: string[];
  /** Full-size-proven relays deliberately left outside the storage ring. */
  reserveRelays: HealthyRelay[];
  /**
   * Discovered candidates the health check early-stopped before reaching.
   * The caller sweeps them in the background so the cache ends up covering
   * the whole discovered population, not just the prefix this ring needed.
   */
  unprobedCandidates: string[];
}

/**
 * The relay ring for an upload: the caller's override, or discovery +
 * health check + rotating batch selection. Relays in `excludeRelays` (the
 * transfer's control relays) and the whole DEFAULT_RELAYS signaling pool
 * never join the ring, whichever path picks it — signaling relays are chosen
 * for small messages, not full-size chunks, and chunk traffic must not compete
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
    reserveCount?: number;
  },
): Promise<UploadRelaySelection> {
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
    [...opts.excludeRelays, ...DEFAULT_RELAYS]
      .map(normalizeRelayUrl)
      .filter((url): url is string => url !== null),
  );
  const isExcluded = (url: string) => {
    const normalized = normalizeRelayUrl(url);
    return normalized === null || excluded.has(normalized);
  };
  if (opts.relayOverride && opts.relayOverride.length > 0) {
    const usable = [
      ...new Set(
        opts.relayOverride
          .map(normalizeRelayUrl)
          .filter((url): url is string => url !== null),
      ),
    ].filter((url) => !isExcluded(url));
    if (usable.length < MIN_UPLOAD_RELAYS) {
      throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
    }
    return {
      storageRelays: seedRing(usable),
      reserveRelays: [],
      unprobedCandidates: [],
    };
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
    opts.excludeRelays
      .map(normalizeRelayUrl)
      .filter((url): url is string => url !== null),
  );
  const doneSeeds = DEFAULT_RELAYS.filter((url) => !controlSet.has(url));
  if (doneSeeds.length > 0) pool.close?.(doneSeeds);
  throwIfCancelled();
  const healthCheckStarted = Date.now();
  const successfulProbes: HealthyRelay[] = [];
  const failedProbes: string[] = [];
  const healthy = await healthCheckRelays(pool, candidates, {
    isCancelled,
    onProgress: (relaysChecked, relaysHealthy, url, rttMs) => {
      if (rttMs === null) failedProbes.push(url);
      else successfulProbes.push({ url, rttMs });
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
  await saveRelayHealth(storage, successfulProbes, failedProbes);
  // Whatever the early stop left untouched, handed back for a background
  // sweep rather than discarded.
  const probed = new Set([
    ...successfulProbes.map((relay) => relay.url),
    ...failedProbes,
  ]);
  const unprobedCandidates = candidates.filter((url) => !probed.has(url));
  throwIfCancelled();
  if (healthy.length < MIN_UPLOAD_RELAYS) {
    throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
  }
  const relays = await selectUploadRelays(healthy, UPLOAD_RELAY_COUNT, storage);
  const ringSet = new Set(relays);
  const reserveRelays = healthy
    .filter((relay) => !ringSet.has(relay.url))
    .slice(0, opts.reserveCount ?? 0);
  const reserveSet = new Set(reserveRelays.map((relay) => relay.url));
  const unselected = healthy
    .filter((r) => !ringSet.has(r.url) && !reserveSet.has(r.url))
    .map((r) => r.url);
  if (unselected.length > 0) pool.close?.(unselected);
  seedRing(relays);
  for (const { url, rttMs } of healthy) {
    const entry = stats.relays.find((r) => r.url === url);
    if (entry) entry.rttMs = rttMs;
  }
  return { storageRelays: relays, reserveRelays, unprobedCandidates };
}

export interface TransferRelaySelection {
  controlRelays: string[];
  /** Already selected only when signaling needed storage reserves. */
  storageRelays: string[] | null;
  /** Empty unless storage discovery already ran for the signaling fallback. */
  unprobedCandidates: string[];
}

/**
 * Resolve the relay sets needed before the manual exchange code is created.
 * Six default signaling relays are probed first. When any are unavailable,
 * storage discovery runs early and its four full-size-proven, unselected
 * relays fill the signaling gaps. The selected sets remain disjoint.
 */
export async function resolveTransferRelays(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  opts: {
    controlRelayOverride?: string[];
    dataRelayOverride?: string[];
    isCancelled: () => boolean;
    onControlProgress: (checked: number, healthy: number) => void;
    onUploadProgress: (p: UploadProgress) => void;
    stats: NostrFileTransferStats;
  },
): Promise<TransferRelaySelection> {
  const { stats } = opts;
  const seedControlStats = (healthy: HealthyRelay[]) => {
    for (const { url, rttMs } of healthy) {
      relayStatsFor(stats, url, 'control').rttMs = rttMs;
    }
    const urls = new Set(healthy.map((relay) => relay.url));
    stats.relays.sort(
      (a, b) => Number(urls.has(b.url)) - Number(urls.has(a.url)),
    );
    return healthy.map((relay) => relay.url);
  };

  if (opts.controlRelayOverride && opts.controlRelayOverride.length > 0) {
    const distinct = [
      ...new Set(
        opts.controlRelayOverride
          .map(normalizeRelayUrl)
          .filter((url): url is string => url !== null),
      ),
    ].slice(0, CONTROL_RELAY_COUNT);
    if (distinct.length < MIN_CONTROL_RELAYS) {
      throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
    }
    for (const relay of distinct) relayStatsFor(stats, relay, 'control');
    return {
      controlRelays: distinct,
      storageRelays: null,
      unprobedCandidates: [],
    };
  }

  const probeStarted = Date.now();
  const healthyDefaults = await healthCheckRelays(pool, [...DEFAULT_RELAYS], {
    probeBytes: CONTROL_PROBE_BYTES,
    timeoutMs: CONTROL_PROBE_TIMEOUT_MS,
    targetCount: CONTROL_RELAY_COUNT,
    isCancelled: opts.isCancelled,
    onProgress: opts.onControlProgress,
  });
  stats.phaseMs.controlProbe = Date.now() - probeStarted;
  if (opts.isCancelled()) throw new NostrFileCancelledError();

  let storageRelays: string[] | null = null;
  let reserves: HealthyRelay[] = [];
  let unprobedCandidates: string[] = [];
  if (healthyDefaults.length < CONTROL_RELAY_COUNT) {
    const upload = await resolveUploadRelays(pool, storage, {
      relayOverride: opts.dataRelayOverride,
      excludeRelays: healthyDefaults.map((relay) => relay.url),
      isCancelled: opts.isCancelled,
      onProgress: opts.onUploadProgress,
      stats,
      reserveCount: SIGNALING_RESERVE_RELAY_COUNT,
    });
    storageRelays = upload.storageRelays;
    reserves = upload.reserveRelays;
    unprobedCandidates = upload.unprobedCandidates;
  }

  const missing = CONTROL_RELAY_COUNT - healthyDefaults.length;
  const usedReserves = reserves.slice(0, missing);
  const unusedReserves = reserves.slice(missing).map((relay) => relay.url);
  if (unusedReserves.length > 0) pool.close?.(unusedReserves);
  const control = [...healthyDefaults, ...usedReserves].slice(
    0,
    CONTROL_RELAY_COUNT,
  );
  if (control.length < MIN_CONTROL_RELAYS) {
    throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
  }

  return {
    controlRelays: seedControlStats(control),
    storageRelays,
    unprobedCandidates,
  };
}
