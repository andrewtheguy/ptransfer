import {
  RELAY_CACHE_DATABASE_NAME,
  RELAY_CACHE_HEALTH_STORE,
  RELAY_CACHE_STATE_STORE,
  RELAY_CACHE_VERSION,
} from './constants';
import {
  parseRelayHealth,
  parseRelayPoolState,
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Relay cache upgrade blocked'));
  });
}

export function createIndexedDbRelayPool(): RelayPoolStorage {
  return {
    async getState() {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_STATE_STORE,
          'readonly',
        );
        const value = await requestResult(
          transaction
            .objectStore(RELAY_CACHE_STATE_STORE)
            .get(RELAY_POOL_STATE_KEY),
        );
        await transactionDone(transaction);
        return parseRelayPoolState(value);
      } catch {
        return null;
      } finally {
        database?.close();
      }
    },
    async setState(state) {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_STATE_STORE,
          'readwrite',
        );
        transaction
          .objectStore(RELAY_CACHE_STATE_STORE)
          .put(storedRelayPoolState(state), RELAY_POOL_STATE_KEY);
        await transactionDone(transaction);
      } catch {
        // Cache persistence never prevents a transfer.
      } finally {
        database?.close();
      }
    },
    async getRelayHealth() {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_HEALTH_STORE,
          'readonly',
        );
        const value = await requestResult(
          transaction.objectStore(RELAY_CACHE_HEALTH_STORE).getAll(),
        );
        await transactionDone(transaction);
        return parseRelayHealth(value);
      } catch {
        return [];
      } finally {
        database?.close();
      }
    },
    async setRelayHealth(relays) {
      let database: IDBDatabase | undefined;
      try {
        database = await openRelayCache();
        const transaction = database.transaction(
          RELAY_CACHE_HEALTH_STORE,
          'readwrite',
        );
        const store = transaction.objectStore(RELAY_CACHE_HEALTH_STORE);
        store.clear();
        for (const relay of storedRelayHealth(relays)) store.put(relay);
        await transactionDone(transaction);
      } catch {
        // Cache persistence never prevents a transfer.
      } finally {
        database?.close();
      }
    },
  };
}
