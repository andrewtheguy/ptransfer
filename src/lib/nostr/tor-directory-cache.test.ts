import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadTorDirectoryCache,
  saveTorDirectoryCache,
} from './tor-directory-cache';

// 12 MiB of three-byte characters: comfortably under the 34 MiB limit counted
// as UTF-16 code units, over it once encoded as UTF-8.
const OVERSIZED_CACHE = '一'.repeat(12 * 1024 * 1024);

describe('Tor directory cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a cache through IndexedDB', async () => {
    await saveTorDirectoryCache('{"version":1}');
    await expect(loadTorDirectoryCache()).resolves.toBe('{"version":1}');

    await saveTorDirectoryCache('{"version":2}');
    await expect(loadTorDirectoryCache()).resolves.toBe('{"version":2}');
  });

  it('refuses to store a cache over the byte limit', async () => {
    await saveTorDirectoryCache('{"version":1}');
    await expect(
      saveTorDirectoryCache(OVERSIZED_CACHE),
    ).resolves.toBeUndefined();

    await expect(loadTorDirectoryCache()).resolves.toBe('{"version":1}');
  });

  it('ignores a stored cache over the byte limit', async () => {
    // Write past the save-side guard to model a cache written by an older
    // build or tampered with directly.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('ptransfer-tor-directory', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('directory', 'readwrite');
        transaction.objectStore('directory').put(OVERSIZED_CACHE, 'current');
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });

    await expect(loadTorDirectoryCache()).resolves.toBeUndefined();
  });

  it('resolves without throwing when an IndexedDB request fails', async () => {
    await saveTorDirectoryCache('{"version":1}');

    const put = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new Error('put failed');
      });
    await expect(
      saveTorDirectoryCache('{"version":2}'),
    ).resolves.toBeUndefined();
    put.mockRestore();

    // The failed write left the previous cache in place.
    await expect(loadTorDirectoryCache()).resolves.toBe('{"version":1}');

    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw new Error('get failed');
    });
    await expect(loadTorDirectoryCache()).resolves.toBeUndefined();
  });

  it('remains optional when IndexedDB is unavailable', async () => {
    const factory = globalThis.indexedDB;
    Reflect.deleteProperty(globalThis, 'indexedDB');
    try {
      expect(globalThis.indexedDB).toBeUndefined();

      await expect(loadTorDirectoryCache()).resolves.toBeUndefined();
      await expect(saveTorDirectoryCache('cache')).resolves.toBeUndefined();
    } finally {
      globalThis.indexedDB = factory;
    }
  });
});
