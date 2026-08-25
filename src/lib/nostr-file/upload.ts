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
  createIndexedDbRelayPool,
  getRelayCandidates,
  type HealthyRelay,
  healthCheckRelays,
  type RelayPoolStorage,
  saveRelayHealth,
  selectUploadRelays,
  sweepRelayHealth,
} from './relay-pool';
import {
  createTransferStats,
  type NostrFileTransferStats,
  relayStatsFor,
} from './stats';

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
  'Not enough working Nostr storage relays found to relay the file. Try again on a network that allows a direct connection.';

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
    /** Full-size-proven relays to keep aside for the signaling fallback. */
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
  const candidates = (
    await getRelayCandidates(pool, storage, { capability: 'storage' })
  ).filter((url) => !isExcluded(url));
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
      // A probe that outlived a cancellation raced the caller tearing the
      // pool down; its verdict says nothing about the relay.
      if (isCancelled()) return;
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
  await saveRelayHealth(storage, successfulProbes, failedProbes, {
    capability: 'storage',
  });
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
  /** Discovery and full-size probe tallies, seeded with the chosen relays. */
  stats: NostrFileTransferStats;
  /**
   * The storage ring, already selected only when signaling had to borrow
   * full-size-proven reserves. Null when every control relay came from the
   * proven defaults, in which case the ring is resolved in the background.
   */
  storageRelays: string[] | null;
  /** Empty unless storage discovery already ran for the signaling fallback. */
  unprobedCandidates: string[];
}

/**
 * Resolve the control (signaling) relays the offer will name, before the code
 * is shown. The manual exchange's robustness rule: probe the DEFAULT_RELAYS
 * seeds with a control-sized write->read round trip, and when fewer than
 * CONTROL_RELAY_COUNT pass, run storage discovery early and fill the gaps from
 * its full-size-proven, ring-excluded reserves — a defunct default is replaced
 * by a relay proven to serve real chunks, never by a weaker control-sized
 * discovery. The control set and the storage ring stay disjoint.
 *
 * When the defaults suffice, no storage work happens here at all: `storageRelays`
 * comes back null and the caller resolves the ring in the background, since the
 * code does not depend on it. When reserves were needed, the ring is already
 * selected and handed back so the caller does not discover twice.
 *
 * Throws NOT_ENOUGH_RELAYS_MESSAGE when fewer than MIN_CONTROL_RELAYS are
 * usable; the caller then falls back to a manual-only offer.
 */
export async function resolveTransferRelays(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  opts: {
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
    stats,
    storageRelays,
    unprobedCandidates,
  };
}

export interface PreparedStorageRelays {
  /**
   * The storage ring. Rejects with NOT_ENOUGH_RELAYS_MESSAGE when too few
   * relays pass the full-size probe, or NostrFileCancelledError when the
   * preparation was cancelled or aborted first.
   */
  ring: Promise<string[]>;
  /**
   * Discovery and health-check tallies (plus the ring's per-relay rows). The
   * transfer that adopts the ring keeps counting into the same object.
   */
  stats: NostrFileTransferStats;
}

/**
 * Prepare the storage ring behind a manual exchange and keep probing the
 * relay population after it — the storage half of the transfer, started as
 * soon as the offer's control relays are known so it runs while the receiver
 * is still reading the code and while WebRTC is still trying. Nothing about
 * the file is touched here; only the relays are prepared. A direct connection
 * leaves the ring unused (and the cache warmer for the next transfer); a
 * failed one hands the ring to `sendFileLive` ready-made.
 *
 * `preselected` is `resolveTransferRelays`'s storage half — non-null only
 * when the signaling fallback already discovered and full-size-probed a ring
 * to borrow reserves from. When it is given, that ring is adopted as-is and
 * only the background sweep continues (from the candidates that pass left
 * unprobed); otherwise `resolveUploadRelays` discovers, probes, and selects
 * the ring here. Either way `sweepRelayHealth` then enumerates and probes the
 * rest of the population for as long as the caller lets it: `signal` ends the
 * sweep at once and voids the verdict of any probe still in flight, so a
 * caller about to destroy the pool never records its own teardown as relay
 * failures. A relay override means the caller picked the relays itself, so
 * there is no discovery to continue and the sweep stays out of it.
 *
 * The returned `ring` promise never surfaces as an unhandled rejection; the
 * caller looks at it only once a transfer needs the ring.
 */
export function prepareStorageRelays(
  pool: NostrFilePool,
  opts: {
    /** Relays carrying the control channel; never rung, never probed. */
    controlRelays: string[];
    /** Continue this tally instead of starting a fresh one. */
    stats?: NostrFileTransferStats;
    /** The ring `resolveTransferRelays` already selected, if any. */
    preselected?: {
      storageRelays: string[];
      unprobedCandidates: string[];
    } | null;
    storage?: RelayPoolStorage;
    relayOverride?: string[];
    signal?: AbortSignal;
    isCancelled?: () => boolean;
    onProgress?: (p: UploadProgress) => void;
  },
): PreparedStorageRelays {
  const storage = opts.storage ?? createIndexedDbRelayPool();
  const stats = opts.stats ?? createTransferStats('sender');
  const isCancelled = () =>
    opts.signal?.aborted === true || opts.isCancelled?.() === true;
  // The whole relay population, uncapped, probed as far as the caller lasts,
  // so the next transfer is not limited to what this one happened to need.
  // Best-effort: its outcome is the cache, never the ring. Skipped for a
  // caller-picked ring — there is no discovery to continue.
  const sweep = (ring: string[], unprobed: string[]) => {
    if (opts.relayOverride?.length) return;
    void sweepRelayHealth(pool, storage, {
      unprobed,
      excludeRelays: [...opts.controlRelays, ...ring],
      signal: opts.signal,
      isCancelled,
    }).catch(() => {});
  };
  const ring = (async () => {
    if (opts.preselected) {
      for (const url of opts.preselected.storageRelays) {
        relayStatsFor(stats, url, 'storage');
      }
      sweep(
        opts.preselected.storageRelays,
        opts.preselected.unprobedCandidates,
      );
      return opts.preselected.storageRelays;
    }
    const upload = await resolveUploadRelays(pool, storage, {
      relayOverride: opts.relayOverride,
      excludeRelays: opts.controlRelays,
      isCancelled,
      onProgress: opts.onProgress ?? (() => {}),
      stats,
    });
    sweep(upload.storageRelays, upload.unprobedCandidates);
    return upload.storageRelays;
  })();
  ring.catch(() => {});
  return { ring, stats };
}
