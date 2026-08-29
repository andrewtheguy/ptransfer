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
  UPLOAD_RELAY_COUNT,
} from './constants';
import type { NostrFilePool } from './pool';
import {
  canonicalUrls,
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
  /**
   * Discovered candidates the health check early-stopped before reaching.
   * The caller sweeps them in the background so the cache ends up covering
   * the whole discovered population, not just the prefix this ring needed.
   */
  unprobedCandidates: string[];
}

/** Excluded-URL matcher: the given relays plus the signaling seed pool. */
function storageExclusion(
  excludeRelays: string[],
  seeds: string[],
): (url: string) => boolean {
  // The seeds are also filtered here (not just in discovery) so a stale
  // candidate cache written before seeds were barred cannot resurface them.
  const excluded = new Set(canonicalUrls([...excludeRelays, ...seeds]));
  return (url: string) => {
    const normalized = normalizeRelayUrl(url);
    return normalized === null || excluded.has(normalized);
  };
}

/**
 * One page of storage-candidate discovery (fresh NIP-66/NIP-65 merged with
 * the cache), minus the excluded relays. Discovery connects to the seeds; the
 * ones not carrying this transfer's control channel have no further job, so
 * their sockets are stopped here.
 */
async function discoverStorageCandidates(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  excludeRelays: string[],
  seeds: string[],
  stats: NostrFileTransferStats,
): Promise<string[]> {
  const isExcluded = storageExclusion(excludeRelays, seeds);
  const discoverStarted = Date.now();
  const candidates = (
    await getRelayCandidates(pool, storage, { capability: 'storage', seeds })
  ).filter((url) => !isExcluded(url));
  stats.candidates = candidates.length;
  stats.phaseMs.discover = Date.now() - discoverStarted;
  // Both sides canonical: a seed compared in any other form would not match
  // the control set and its socket would be closed out from under the
  // control channel it is carrying.
  const controlSet = new Set(canonicalUrls(excludeRelays));
  const doneSeeds = seeds.filter((url) => !controlSet.has(url));
  if (doneSeeds.length > 0) pool.close?.(doneSeeds);
  return candidates;
}

/** What one discovery pass leaves for a later ring selection. */
export interface DiscoveredStorageRelays {
  /** Full-size-proven relays no one has used yet. */
  proven: HealthyRelay[];
  /** Candidates the early stop never reached. */
  unprobed: string[];
}

/**
 * Full-size-probe candidates until `targetCount` pass (or the list runs
 * out) and record every verdict in the cache. `healthy` is the capped,
 * fastest-first selection; `passed` is every relay that passed, including
 * those that came in after the target filled (their sockets are closed, but
 * their verdicts are good), and `unprobedCandidates` whatever the early
 * stop left untouched.
 */
async function probeStorageCandidates(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  candidates: string[],
  opts: {
    targetCount: number;
    isCancelled: () => boolean;
    onProgress: (p: UploadProgress) => void;
    stats: NostrFileTransferStats;
  },
): Promise<{
  healthy: HealthyRelay[];
  passed: HealthyRelay[];
  unprobedCandidates: string[];
}> {
  const { isCancelled, onProgress, stats } = opts;
  const healthCheckStarted = Date.now();
  const successfulProbes: HealthyRelay[] = [];
  const failedProbes: string[] = [];
  const healthy = await healthCheckRelays(pool, candidates, {
    targetCount: opts.targetCount,
    isCancelled,
    onProgress: (_checked, _healthy, url, rttMs) => {
      // A probe that outlived a cancellation raced the caller tearing the
      // pool down; its verdict says nothing about the relay.
      if (isCancelled()) return;
      if (rttMs === null) failedProbes.push(url);
      else successfulProbes.push({ url, rttMs });
      // Cumulative across the backfill probe and the ring probe.
      stats.relaysChecked++;
      if (rttMs !== null) stats.relaysHealthy++;
      onProgress({
        phase: 'health_check',
        relaysChecked: stats.relaysChecked,
        relaysHealthy: stats.relaysHealthy,
        stats,
      });
    },
  });
  stats.phaseMs.healthCheck =
    (stats.phaseMs.healthCheck ?? 0) + (Date.now() - healthCheckStarted);
  await saveRelayHealth(storage, successfulProbes, failedProbes, {
    capability: 'storage',
  });
  const probed = new Set([
    ...successfulProbes.map((relay) => relay.url),
    ...failedProbes,
  ]);
  return {
    healthy,
    passed: successfulProbes,
    unprobedCandidates: candidates.filter((url) => !probed.has(url)),
  };
}

/**
 * The relay ring for an upload: the caller's override, or discovery +
 * health check + rotating batch selection. Relays in `excludeRelays` (the
 * transfer's control relays) and the whole signaling seed pool
 * never join the ring, whichever path picks it — signaling relays are chosen
 * for small messages, not full-size chunks, and chunk traffic must not compete
 * with the control channel. `discovered` skips discovery: an earlier pass's
 * proven-but-unused relays join the ring without another probe and only its
 * unprobed leftovers are probed, up to the ring size. Throws when fewer than
 * MIN_UPLOAD_RELAYS relays are usable.
 */
export async function resolveUploadRelays(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  opts: {
    relayOverride?: string[];
    excludeRelays: string[];
    /**
     * Signaling seed pool: probed for the control channel, queried for
     * discovery, and barred from the storage ring. Defaults to
     * DEFAULT_RELAYS.
     */
    seeds?: string[];
    discovered?: DiscoveredStorageRelays | null;
    isCancelled: () => boolean;
    onProgress: (p: UploadProgress) => void;
    stats: NostrFileTransferStats;
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
  const seeds = canonicalUrls(opts.seeds ?? [...DEFAULT_RELAYS]);
  const isExcluded = storageExclusion(opts.excludeRelays, seeds);
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
    return { storageRelays: seedRing(usable), unprobedCandidates: [] };
  }
  let candidates: string[];
  const proven = (opts.discovered?.proven ?? []).filter(
    (relay) => !isExcluded(relay.url),
  );
  if (opts.discovered) {
    candidates = opts.discovered.unprobed.filter((url) => !isExcluded(url));
  } else {
    onProgress({ phase: 'discovering', stats });
    candidates = await discoverStorageCandidates(
      pool,
      storage,
      opts.excludeRelays,
      seeds,
      stats,
    );
  }
  throwIfCancelled();
  const probed = await probeStorageCandidates(pool, storage, candidates, {
    targetCount: Math.max(0, UPLOAD_RELAY_COUNT - proven.length),
    isCancelled,
    onProgress,
    stats,
  });
  throwIfCancelled();
  const healthy = [...proven, ...probed.healthy].sort(
    (a, b) => a.rttMs - b.rttMs,
  );
  const unprobedCandidates = probed.unprobedCandidates;
  if (healthy.length < MIN_UPLOAD_RELAYS) {
    throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
  }
  const relays = await selectUploadRelays(healthy, UPLOAD_RELAY_COUNT, storage);
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
  return { storageRelays: relays, unprobedCandidates };
}

export interface TransferRelaySelection {
  controlRelays: string[];
  /** Discovery and probe tallies, seeded with the chosen relays. */
  stats: NostrFileTransferStats;
  /**
   * What the backfill's discovery pass left over — non-null only when
   * signaling had to backfill from discovery. The background ring
   * preparation continues from it instead of discovering again.
   */
  discovered: DiscoveredStorageRelays | null;
}

/**
 * Resolve the control (signaling) relays the offer will name, before the code
 * is shown. Only what the code needs is awaited here: probe the signaling
 * seeds with a control-sized write->read round trip, and when fewer than
 * CONTROL_RELAY_COUNT pass, discover storage candidates and full-size-probe
 * them only until the gap is filled — a defunct default is replaced by a relay
 * proven to serve real chunks, never by a weaker control-sized discovery, and
 * the probe stops the moment enough have passed. The storage ring is never
 * built here: the caller prepares it in the background from what the probe
 * left over (`discovered`), since the code does not depend on it.
 * The control set and the ring stay disjoint.
 *
 * Throws NOT_ENOUGH_RELAYS_MESSAGE when fewer than MIN_CONTROL_RELAYS are
 * usable; the caller then falls back to a relay-free Code Exchange offer.
 */
export async function resolveTransferRelays(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  opts: {
    /**
     * Signaling seed pool: probed for the control channel, queried for
     * discovery, and barred from the storage ring. Defaults to
     * DEFAULT_RELAYS.
     */
    seeds?: string[];
    isCancelled: () => boolean;
    onControlProgress: (checked: number, healthy: number) => void;
    onUploadProgress: (p: UploadProgress) => void;
    stats: NostrFileTransferStats;
  },
): Promise<TransferRelaySelection> {
  const { stats } = opts;
  const seeds = canonicalUrls(opts.seeds ?? [...DEFAULT_RELAYS]);
  const throwIfCancelled = () => {
    if (opts.isCancelled()) throw new NostrFileCancelledError();
  };
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
  // Record a verdict for every seed, not just the ones that pass. Only
  // healthy seeds go on to carry control traffic, so without this a seed that
  // has gone bad leaves no trace anywhere — it simply stops appearing, which
  // reads the same as never having been in the pool.
  stats.seedProbes = seeds.map((url) => ({ url }));
  const healthyDefaults = await healthCheckRelays(pool, seeds, {
    probeBytes: CONTROL_PROBE_BYTES,
    timeoutMs: CONTROL_PROBE_TIMEOUT_MS,
    targetCount: CONTROL_RELAY_COUNT,
    isCancelled: opts.isCancelled,
    onProgress: (checked, healthy, url, rttMs) => {
      const probe = stats.seedProbes.find((seed) => seed.url === url);
      if (probe) probe.rttMs = rttMs;
      opts.onControlProgress(checked, healthy);
    },
  });
  stats.phaseMs.controlProbe = Date.now() - probeStarted;
  throwIfCancelled();

  let backfill: HealthyRelay[] = [];
  let discovered: DiscoveredStorageRelays | null = null;
  const missing = CONTROL_RELAY_COUNT - healthyDefaults.length;
  if (missing > 0) {
    opts.onUploadProgress({ phase: 'discovering', stats });
    const candidates = await discoverStorageCandidates(
      pool,
      storage,
      healthyDefaults.map((relay) => relay.url),
      seeds,
      stats,
    );
    throwIfCancelled();
    const probed = await probeStorageCandidates(pool, storage, candidates, {
      targetCount: missing,
      isCancelled: opts.isCancelled,
      onProgress: opts.onUploadProgress,
      stats,
    });
    throwIfCancelled();
    backfill = probed.healthy.slice(0, missing);
    const taken = new Set(backfill.map((relay) => relay.url));
    discovered = {
      proven: probed.passed.filter((relay) => !taken.has(relay.url)),
      unprobed: probed.unprobedCandidates,
    };
  }

  const control = [...healthyDefaults, ...backfill];
  if (control.length < MIN_CONTROL_RELAYS) {
    throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
  }

  return { controlRelays: seedControlStats(control), stats, discovered };
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
 * Prepare the storage ring behind a Code Exchange and keep probing the
 * relay population after it — the storage half of the transfer, started as
 * soon as the offer's control relays are known so it runs while the receiver
 * is still reading the code and while WebRTC is still trying. Nothing about
 * the file is touched here; only the relays are prepared. A direct connection
 * leaves the ring unused (and the cache warmer for the next transfer); a
 * failed one hands the ring to `sendFileLive` ready-made.
 *
 * `discovered` is what `resolveTransferRelays`'s backfill left over when
 * signaling had to discover; given, the ring is selected from it (proven
 * relays as they are, unprobed ones probed) without discovering again. Otherwise
 * `resolveUploadRelays` discovers, probes, and selects the ring here. Either
 * way `sweepRelayHealth` then enumerates and probes the rest of the
 * population for as long as the caller lets it: `signal` ends the
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
    /** What `resolveTransferRelays`'s backfill discovery left over, if any. */
    discovered?: DiscoveredStorageRelays | null;
    /**
     * Signaling seed pool: probed for the control channel, queried for
     * discovery, and barred from the storage ring. Defaults to
     * DEFAULT_RELAYS.
     */
    seeds?: string[];
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
      seeds: opts.seeds,
      excludeRelays: [...opts.controlRelays, ...ring],
      signal: opts.signal,
      isCancelled,
    }).catch(() => {});
  };
  const ring = (async () => {
    const upload = await resolveUploadRelays(pool, storage, {
      relayOverride: opts.relayOverride,
      excludeRelays: opts.controlRelays,
      seeds: opts.seeds,
      discovered: opts.discovered,
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
