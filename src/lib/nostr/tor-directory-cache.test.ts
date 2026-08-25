import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadTorDirectoryCache,
  saveTorDirectoryCache,
} from './tor-directory-cache';

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
