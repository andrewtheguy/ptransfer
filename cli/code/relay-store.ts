import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RELAY_CACHE_VERSION } from '@/lib/nostr-file/constants';
import {
  emptyRelayCache,
  parseRelayHealth,
  parseRelayPoolState,
  type RelayCacheContents,
  type RelayPoolStorage,
  storedRelayHealth,
  storedRelayPoolState,
} from '@/lib/nostr-file/relay-pool';
import { type FileLock, fileLock } from '../file-lock';

/**
 * The relay cache on disk: what earlier transfers learned about the public
 * Nostr relays — the candidate list with its ring cursor, and one health
 * record per relay — so a sender's fallback starts from relays already proven
 * rather than sampling the population again. The browser tab keeps the same
 * records in IndexedDB (`src/lib/nostr-file/relay-cache-idb.ts`); what they
 * mean, and how a stored one is read back, is `relay-pool.ts`'s.
 *
 * One JSON file beside the Tor directory seed. Several transfers may run on
 * one machine at once, so every change is a locked read-modify-write, as the
 * retired Rust CLI's was: an exclusive lock on a sibling lock file, the file
 * read again under it, the change applied to *that*, and the result renamed
 * into place. A second process therefore adds its verdicts to the first's
 * rather than overwriting them, and a reader, which takes no lock, never sees
 * a torn file. The lock is on a separate file because the rename replaces the
 * cache file's inode, and a lock on the old one would mean nothing to the
 * next writer.
 *
 * Nothing here can fail a transfer: a missing, unreadable, or unparseable
 * file, or one of another version, is an empty cache, and a change that
 * cannot take the lock or write its result is applied and dropped. The file
 * holds relay URLs and verdicts, nothing about any transfer.
 *
 * Where it lives is `PTRANSFER_RELAY_CACHE`'s to say; `createRelayStore` is
 * the entry point that reads it.
 */

const CACHE_FILE = 'relay-cache.json';
const LOCK_FILE = 'relay-cache.lock';

interface CacheFile extends RelayCacheContents {
  version: typeof RELAY_CACHE_VERSION;
}

export function openRelayStore(
  cacheDir: string,
  lock: FileLock = fileLock(join(cacheDir, LOCK_FILE)),
): RelayPoolStorage {
  const path = join(cacheDir, CACHE_FILE);

  const read = async (): Promise<RelayCacheContents> => {
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (value && typeof value === 'object') {
        const file = value as Record<string, unknown>;
        if (file.version === RELAY_CACHE_VERSION) {
          return {
            state: parseRelayPoolState(file.state),
            relays: parseRelayHealth(file.relays),
          };
        }
      }
    } catch {
      // Missing or unreadable: an empty cache.
    }
    return emptyRelayCache();
  };

  const write = async (cache: RelayCacheContents) => {
    // Written beside the file and renamed over it: the rename is atomic
    // within one directory, so the file is always one whole write.
    const partial = `${path}.${process.pid}.part`;
    const file: CacheFile = {
      version: RELAY_CACHE_VERSION,
      state: cache.state && storedRelayPoolState(cache.state),
      relays: storedRelayHealth(cache.relays),
    };
    try {
      await writeFile(partial, JSON.stringify(file));
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  return {
    read,
    async update(change) {
      let applied = false;
      let refused = false;
      let result!: ReturnType<typeof change>;
      try {
        await mkdir(cacheDir, { recursive: true });
        await lock(async () => {
          const cache = await read();
          try {
            result = change(cache);
          } catch (error) {
            // The change itself failed. It is the caller's error, and the
            // change is not run a second time.
            refused = true;
            throw error;
          }
          applied = true;
          await write(cache);
        });
      } catch (error) {
        if (refused) throw error;
        // Cache persistence never prevents a transfer: a change that could
        // not be kept still gets its answer.
        if (!applied) result = change(await read());
      }
      return result;
    },
  };
}

/** The environment variable that moves the relay cache, or turns it off. */
export const RELAY_CACHE_ENV = 'PTRANSFER_RELAY_CACHE';

/**
 * Where this run keeps the relay cache: the directory `PTRANSFER_RELAY_CACHE`
 * names, nowhere at all when it is `off`, and otherwise `cacheDir` — beside
 * the Tor directory seed, which is what `--cache-dir` moves.
 *
 * The two move separately because they are not the same kind of thing. The
 * directory seed is a download worth reusing; the relay cache is a record of
 * what this machine has learned about which public relays work, and somebody
 * who wants a run to leave none of it behind, or to keep it somewhere of
 * their own, says so here rather than moving the seed along with it. A
 * relative path is taken from the working directory, unlike `XDG_CACHE_HOME`,
 * which the spec says to ignore when it is one: this was asked for by name.
 */
export function relayCacheDir(cacheDir: string): string | null {
  const asked = process.env[RELAY_CACHE_ENV]?.trim();
  if (!asked) return cacheDir;
  if (asked.toLowerCase() === 'off') return null;
  return resolve(asked);
}

/**
 * A relay cache for one run and no longer: what this transfer proves leads
 * its own later probes, and goes with the process. `read` hands back a copy
 * that has been through the same parsers a file's contents would have, so
 * nothing can tell it from the file store except by looking for the file.
 */
export function memoryRelayStore(): RelayPoolStorage {
  const held = emptyRelayCache();
  // Neither method waits for anything; both are promises because the storage
  // they stand in for is a file. A `change` that throws rejects rather than
  // throwing where it was called, which is what the file store does with one.
  return {
    read() {
      return Promise.resolve({
        state: parseRelayPoolState(
          held.state && storedRelayPoolState(held.state),
        ),
        relays: parseRelayHealth(storedRelayHealth(held.relays)),
      });
    },
    // The change is applied to what is held, which is what keeps it: the file
    // store's `change` mutates the cache it was handed in the same way.
    update(change) {
      try {
        return Promise.resolve(change(held));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

/**
 * The relay cache this run will use, wherever the environment asks for it.
 * A transfer never sees which of the two it got.
 */
export function createRelayStore(cacheDir: string): RelayPoolStorage {
  const dir = relayCacheDir(cacheDir);
  return dir === null ? memoryRelayStore() : openRelayStore(dir);
}
