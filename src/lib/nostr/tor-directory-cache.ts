const DATABASE_NAME = 'ptransfer-tor-directory';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'directory';
const CACHE_KEY = 'current';
const MAX_CACHE_BYTES = 34 * 1024 * 1024;

/**
 * The limit is a byte budget, so measure the encoded form. UTF-8 never uses
 * fewer bytes than the string has UTF-16 code units, so an oversized length
 * settles the question without materializing tens of megabytes.
 */
function exceedsCacheLimit(value: string): boolean {
  if (value.length > MAX_CACHE_BYTES) return true;
  return new TextEncoder().encode(value).length > MAX_CACHE_BYTES;
}

function cacheLog(message: string, error: unknown): void {
  console.info(
    `[Anonymous signaling] ${message}`,
    error instanceof Error ? error.message : error,
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        database.createObjectStore(OBJECT_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open IndexedDB'));
    request.onblocked = () =>
      reject(new Error('Tor directory cache database upgrade was blocked'));
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
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * Load the opaque Rust directory cache. It is handed to Rust as a bootstrap
 * fallback, validated and installed only if the live directory download fails.
 */
export async function loadTorDirectoryCache(): Promise<string | undefined> {
  if (!globalThis.indexedDB) return undefined;

  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
    const value = await requestResult<unknown>(
      transaction.objectStore(OBJECT_STORE_NAME).get(CACHE_KEY),
    );
    if (typeof value !== 'string' || exceedsCacheLimit(value)) {
      return undefined;
    }
    return value;
  } catch (error) {
    cacheLog('Could not read the Tor directory cache:', error);
    return undefined;
  } finally {
    database?.close();
  }
}

/** Atomically replace the cache after Rust has completed a valid bootstrap. */
export async function saveTorDirectoryCache(cache: string): Promise<void> {
  if (!globalThis.indexedDB || exceedsCacheLimit(cache)) return;

  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
    const completed = transactionComplete(transaction);
    transaction.objectStore(OBJECT_STORE_NAME).put(cache, CACHE_KEY);
    await completed;
  } catch (error) {
    cacheLog('Could not save the Tor directory cache:', error);
  } finally {
    database?.close();
  }
}
