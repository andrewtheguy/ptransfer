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
 * older than it understands. So a stale or tampered entry costs a download,
 * never correctness.
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
  if (cached) return { value: cached, source: 'browser cache' };

  const snapshot = await loadSnapshot();
  if (snapshot) return { value: snapshot, source: 'served snapshot' };

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
