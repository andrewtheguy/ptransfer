/**
 * Persisting the Tor directory between bootstraps.
 *
 * Downloading the consensus and every HSDir microdescriptor over a single
 * Snowflake circuit is by far the slowest part of a cold start — minutes, not
 * seconds — and it is the same documents every time. `directoryCache()` hands
 * back what the client verified during a bootstrap; keeping it in IndexedDB
 * makes the next transfer in this browser start in seconds.
 *
 * A seed needs no trust of its own: the client re-verifies the consensus
 * against its pinned directory authorities before installing anything from it,
 * and rejects one whose consensus has expired (three hours) or whose format is
 * older than it understands. So a tampered entry costs a download, never
 * correctness.
 *
 * Timeliness is not enough, though, and that is what `judgeDirectorySeed`
 * adds. Where an onion descriptor lives is derived from the consensus's own
 * `valid-after`, so a seed from before a time-period rotation places the whole
 * HSDir ring one period back: a service publishes to the current ring while a
 * client with such a seed asks the previous one, and every HSDir it tries
 * answers 404. The consensus is still valid at that point — it is just
 * describing the ring the network has stopped using — so the freshness rule
 * has to be ours, and it applies to publishing and fetching alike.
 */

const DATABASE_NAME = 'ptransfer-tor';
const DATABASE_VERSION = 1;
const STORE_NAME = 'directory';
const CACHE_KEY = 'current';

/**
 * A directory snapshot served with the app, if one was built into this
 * deployment. Absent from the repository on purpose: a consensus is valid for
 * a few hours, so a committed snapshot would be stale for almost all of its
 * life. See docs/TOR_TRANSPORT.md for how to build one while testing.
 */
const SNAPSHOT_URL = '/tor-directory.json';

/**
 * Onion-service time-period placement, mirroring webtor's `HsDirParams`: a
 * period is `hsdir_interval` minutes long and starts twelve voting periods
 * after the epoch, which puts the default boundary at 12:00 UTC.
 */
const HSDIR_INTERVAL_DEFAULT_MINUTES = 1440;
const HSDIR_INTERVAL_MIN_MINUTES = 30;
const HSDIR_INTERVAL_MAX_MINUTES = 14400;
const VOTING_PERIODS_IN_OFFSET = 12;
const DEFAULT_VOTING_PERIOD_MS = 60 * 60 * 1000;

/** A seed with less life than this left would expire during the bootstrap. */
const MIN_REMAINING_MS = 10 * 60 * 1000;

/** The consensus fields both the description and the freshness rule read. */
interface ParsedDirectory {
  validAfter: number;
  validUntil: number;
  /** How long one onion-service time period lasts, in milliseconds. */
  periodLength: number;
  /** How far the first period starts after the epoch, in milliseconds. */
  periodOffset: number;
}

/** What a directory says about where onion descriptors live. */
export interface DirectoryDescription {
  validAfter: Date;
  validUntil: Date;
  /**
   * The onion-service time period the consensus falls in. Both peers must be
   * in the same one: a service publishes its descriptor to the HSDirs this
   * number places it on, and a client with a different number asks HSDirs the
   * service never uploaded to, which answer 404 without explaining why.
   */
  timePeriod: number;
}

/** `valid-after 2026-08-27 12:00:00`, in UTC as the directory spec defines. */
function consensusTime(consensus: string, field: string): number | undefined {
  const match = new RegExp(
    `^${field} (\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})$`,
    'm',
  ).exec(consensus);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function hsdirIntervalMinutes(consensus: string): number {
  const params = /^params (.*)$/m.exec(consensus)?.[1];
  const declared = params
    ? Number(/(?:^| )hsdir_interval=(-?\d+)(?: |$)/.exec(params)?.[1])
    : Number.NaN;
  if (!Number.isFinite(declared)) return HSDIR_INTERVAL_DEFAULT_MINUTES;
  return Math.min(
    Math.max(Math.abs(declared), HSDIR_INTERVAL_MIN_MINUTES),
    HSDIR_INTERVAL_MAX_MINUTES,
  );
}

/**
 * Read the validity window and time period out of a directory, cached or
 * freshly downloaded.
 *
 * Purely descriptive: nothing here decides whether a directory may be used.
 * It exists so that a transfer that fails with nothing but 404s from every
 * HSDir can be diagnosed from the two peers' logs, where a period that does
 * not match is immediately visible.
 */
export function describeDirectory(
  directory: string,
): DirectoryDescription | undefined {
  const parsed = parseDirectory(directory);
  if (!parsed) return undefined;
  return {
    validAfter: new Date(parsed.validAfter),
    validUntil: new Date(parsed.validUntil),
    timePeriod: timePeriodAt(parsed, parsed.validAfter),
  };
}

function parseDirectory(directory: string): ParsedDirectory | undefined {
  let consensus: unknown;
  try {
    consensus = (JSON.parse(directory) as { consensus?: unknown }).consensus;
  } catch {
    return undefined;
  }
  if (typeof consensus !== 'string') return undefined;

  const validAfter = consensusTime(consensus, 'valid-after');
  const validUntil = consensusTime(consensus, 'valid-until');
  if (validAfter === undefined || validUntil === undefined) return undefined;

  const freshUntil = consensusTime(consensus, 'fresh-until');
  const votingPeriod =
    freshUntil !== undefined && freshUntil > validAfter
      ? freshUntil - validAfter
      : DEFAULT_VOTING_PERIOD_MS;

  return {
    validAfter,
    validUntil,
    periodLength: hsdirIntervalMinutes(consensus) * 60_000,
    periodOffset: votingPeriod * VOTING_PERIODS_IN_OFFSET,
  };
}

function timePeriodAt(directory: ParsedDirectory, at: number): number {
  return Math.floor((at - directory.periodOffset) / directory.periodLength);
}

export interface SeedVerdict {
  usable: boolean;
  /** Why not, phrased to follow "Ignoring the cached directory:". */
  reason?: string;
}

/**
 * Whether a seed still describes the network as it is now — both that its
 * consensus is live, and that it belongs to the onion-service time period in
 * force at `now`.
 *
 * The second half is the one that is easy to miss. A consensus stays valid for
 * three hours, but the period rotates on its own schedule, so a seed saved at
 * 11:00 UTC is still perfectly valid at 13:00 and still places the HSDir ring
 * where it was before noon. Seeding a client with it sends every descriptor
 * lookup to relays the service never uploaded to, and seeding a *service* with
 * it publishes where no current client will look.
 */
export function judgeDirectorySeed(
  seed: string,
  now: number = Date.now(),
): SeedVerdict {
  const parsed = parseDirectory(seed);
  if (!parsed) {
    return { usable: false, reason: 'it carries no readable consensus' };
  }
  if (now < parsed.validAfter) {
    return { usable: false, reason: 'its consensus is not valid yet' };
  }
  if (now + MIN_REMAINING_MS > parsed.validUntil) {
    return {
      usable: false,
      reason: `its consensus expires at ${new Date(parsed.validUntil).toISOString()}`,
    };
  }
  if (timePeriodAt(parsed, parsed.validAfter) !== timePeriodAt(parsed, now)) {
    return {
      usable: false,
      reason:
        'its consensus is from a previous onion-service time period, which ' +
        'would place every descriptor on the wrong HSDirs',
    };
  }
  return { usable: true };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open IndexedDB'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function loadSnapshot(): Promise<string | undefined> {
  try {
    const response = await fetch(SNAPSHOT_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return undefined;
    const snapshot = await response.text();
    // A deployment without a snapshot answers the SPA fallback, which is HTML.
    return snapshot.startsWith('{"version":') ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

async function loadStoredCache(): Promise<string | undefined> {
  if (!globalThis.indexedDB) return undefined;
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const value = await requestResult<unknown>(
      transaction.objectStore(STORE_NAME).get(CACHE_KEY),
    );
    return typeof value === 'string' ? value : undefined;
  } catch (error) {
    console.info('[tor] Could not read the directory cache:', error);
    return undefined;
  } finally {
    database?.close();
  }
}

export interface DirectorySeed {
  value: string | undefined;
  /** Where the seed came from; surfaced so a slow start explains itself. */
  source: 'served snapshot' | 'browser cache' | 'Tor download';
}

/** The best directory seed available without touching the Tor network. */
export async function loadDirectorySeed(): Promise<DirectorySeed> {
  const cached = await loadStoredCache();
  if (cached) {
    const verdict = judgeDirectorySeed(cached);
    if (verdict.usable) return { value: cached, source: 'browser cache' };
    console.info(`[tor] Ignoring the cached directory: ${verdict.reason}`);
  }

  const snapshot = await loadSnapshot();
  if (snapshot) {
    const verdict = judgeDirectorySeed(snapshot);
    if (verdict.usable) return { value: snapshot, source: 'served snapshot' };
    console.info(
      `[tor] Ignoring the served directory snapshot: ${verdict.reason}`,
    );
  }

  return { value: undefined, source: 'Tor download' };
}

/** Keep a verified directory for the next bootstrap. Best effort throughout. */
export async function saveDirectoryCache(cache: string): Promise<void> {
  if (!globalThis.indexedDB) return;
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const complete = transactionComplete(transaction);
    transaction.objectStore(STORE_NAME).put(cache, CACHE_KEY);
    await complete;
  } catch (error) {
    console.info('[tor] Could not save the directory cache:', error);
  } finally {
    database?.close();
  }
}
