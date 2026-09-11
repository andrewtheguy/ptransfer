import {
  RELAY_CACHE_DATABASE_NAME,
  RELAY_CACHE_HEALTH_STORE,
  RELAY_CACHE_STATE_STORE,
  RELAY_CACHE_VERSION,
} from './constants';
import {
  emptyRelayCache,
  parseRelayHealth,
  parseRelayPoolState,
  type RelayCacheContents,
  type RelayPoolStorage,
  storedRelayHealth,
  storedRelayPoolState,
} from './relay-pool';

/**
 * The browser tab's relay cache, in IndexedDB. The CLI keeps the same cache
 * in a file; what goes in it and how it is read back is `relay-pool.ts`'s,
 * shared by both.
 */

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
      RELAY_CACHE_VERSION,
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
      database.createObjectStore(RELAY_CACHE_HEALTH_STORE, {
        keyPath: 'url',
      });
    };
    // A blocked open is given up on, but the request carries on and may still
    // succeed once the other connection closes; nothing would close that one.
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Relay cache upgrade blocked'));
    };
  });
}

/**
 * Read both stores in `transaction` and parse what they hold. Only IndexedDB
 * requests are awaited, so a readwrite transaction is still active after it.
 */
async function readCache(
  transaction: IDBTransaction,
): Promise<RelayCacheContents> {
  const [state, relays] = await Promise.all([
    requestResult(
      transaction
        .objectStore(RELAY_CACHE_STATE_STORE)
        .get(RELAY_POOL_STATE_KEY),
    ),
    requestResult(transaction.objectStore(RELAY_CACHE_HEALTH_STORE).getAll()),
  ]);
  return {
    state: parseRelayPoolState(state),
    relays: parseRelayHealth(relays),
  };
}

const STORES = [RELAY_CACHE_STATE_STORE, RELAY_CACHE_HEALTH_STORE];

export function createIndexedDbRelayPool(): RelayPoolStorage {
  return {
    async read() {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(STORES, 'readonly');
        const cache = await readCache(transaction);
        await transactionDone(transaction);
        return cache;
      } catch {
        return emptyRelayCache();
      } finally {
        database?.close();
      }
    },
    async update(change) {
      let database: IDBDatabase | undefined;
      let transaction: IDBTransaction | undefined;
      let cache: RelayCacheContents;
      try {
        database = await openRelayCache();
        // One readwrite transaction over both stores: IndexedDB runs it to
        // completion before any other that touches them, in this tab or
        // another, which is what makes the read-modify-write whole.
        transaction = database.transaction(STORES, 'readwrite');
        cache = await readCache(transaction);
      } catch {
        database?.close();
        // Unreadable: the change still gets an answer, and nothing is kept.
        return change(emptyRelayCache());
      }
      const result = change(cache);
      try {
        const { state, relays } = cache;
        if (state) {
          transaction
            .objectStore(RELAY_CACHE_STATE_STORE)
            .put(storedRelayPoolState(state), RELAY_POOL_STATE_KEY);
        }
        const health = transaction.objectStore(RELAY_CACHE_HEALTH_STORE);
        health.clear();
        for (const relay of storedRelayHealth(relays)) health.put(relay);
        await transactionDone(transaction);
      } catch {
        // Cache persistence never prevents a transfer.
      } finally {
        database.close();
      }
      return result;
    },
  };
}
