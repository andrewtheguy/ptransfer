import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RELAY_CACHE_VERSION } from '@/lib/nostr-file/constants';
import {
  type CachedRelay,
  parseRelayHealth,
  parseRelayPoolState,
  type RelayPoolState,
  type RelayPoolStorage,
  storedRelayHealth,
  storedRelayPoolState,
} from '@/lib/nostr-file/relay-pool';

/**
 * The relay cache on disk: what earlier transfers learned about the public
 * Nostr relays — the candidate list with its ring cursor, and one health
 * record per relay — so a sender's fallback starts from relays already proven
 * rather than sampling the population again. The browser tab keeps the same
 * records in IndexedDB (`src/lib/nostr-file/relay-cache-idb.ts`); what they
 * mean, and how a stored one is read back, is `relay-pool.ts`'s.
 *
 * One JSON file beside the Tor directory seed. Each write replaces the file
 * by rename, so a reader never sees half of one. `RelayPoolStorage` is a get
 * and a set rather than a read-modify-write, so two transfers running at once
 * can lose each other's latest verdicts — the cost is a probe, as it is
 * between two tabs.
 *
 * Nothing here can fail a transfer: a missing, unreadable, or unparseable
 * file, or one of another version, is an empty cache, and a write that fails
 * is dropped. The file holds relay URLs and verdicts, nothing about any
 * transfer.
 */

const CACHE_FILE = 'relay-cache.json';

interface CacheFile {
  version: typeof RELAY_CACHE_VERSION;
  state: RelayPoolState | null;
  relays: CachedRelay[];
}

export function openRelayStore(cacheDir: string): RelayPoolStorage {
  const path = join(cacheDir, CACHE_FILE);
  // One change at a time from this process, so a set never writes back a
  // file another set from here has since replaced.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op);
    chain = run.catch(() => undefined);
    return run;
  };

  const read = async (): Promise<CacheFile> => {
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (
        value &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).version === RELAY_CACHE_VERSION
      ) {
        const file = value as Record<string, unknown>;
        return {
          version: RELAY_CACHE_VERSION,
          state: parseRelayPoolState(file.state),
          relays: parseRelayHealth(file.relays),
        };
      }
    } catch {
      // Missing or unreadable: an empty cache.
    }
    return { version: RELAY_CACHE_VERSION, state: null, relays: [] };
  };

  const change = (edit: (file: CacheFile) => CacheFile) =>
    serialize(async () => {
      // Written beside the file and renamed over it: the rename is atomic
      // within one directory, so the file is always one whole write.
      const partial = `${path}.${process.pid}.part`;
      try {
        const next = edit(await read());
        await mkdir(cacheDir, { recursive: true });
        await writeFile(partial, JSON.stringify(next));
        await rename(partial, path);
      } catch {
        // Cache persistence never prevents a transfer.
        await rm(partial, { force: true }).catch(() => undefined);
      }
    });

  return {
    getState: () => serialize(async () => (await read()).state),
    setState: (state) =>
      change((file) => ({ ...file, state: storedRelayPoolState(state) })),
    getRelayHealth: () => serialize(async () => (await read()).relays),
    setRelayHealth: (relays) =>
      change((file) => ({ ...file, relays: storedRelayHealth(relays) })),
  };
}
