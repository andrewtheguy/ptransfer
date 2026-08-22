import type { Event } from 'nostr-tools';
import {
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
  const relayStats = relayStatsFor(stats, relay);
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
 * The relay ring for an upload: the caller's override, or discovery +
 * health check + rotating batch selection. Throws when fewer than
 * MIN_UPLOAD_RELAYS relays are usable.
 */
export async function resolveUploadRelays(
  pool: NostrFilePool,
  storage: RelayPoolStorage,
  opts: {
    relayOverride?: string[];
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
    for (const relay of relays) relayStatsFor(stats, relay);
    return relays;
  };
  if (opts.relayOverride && opts.relayOverride.length > 0) {
    if (opts.relayOverride.length < MIN_UPLOAD_RELAYS) {
      throw new Error(NOT_ENOUGH_RELAYS_MESSAGE);
    }
    return seedRing(opts.relayOverride);
  }
  onProgress({ phase: 'discovering', stats });
  const discoverStarted = Date.now();
  const candidates = await getRelayCandidates(pool, storage);
  stats.candidates = candidates.length;
  stats.phaseMs.discover = Date.now() - discoverStarted;
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
  seedRing(relays);
  for (const { url, rttMs } of healthy) {
    const entry = stats.relays.find((r) => r.url === url);
    if (entry) entry.rttMs = rttMs;
  }
  return relays;
}
