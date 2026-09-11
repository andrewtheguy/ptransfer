import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { judgeDescription } from '@/lib/tor/directory-policy';
import type { DirectoryDescription } from '@/lib/tor/webtor-api';

/**
 * The Tor directory seed on disk, under the user's cache directory.
 *
 * The browser tab keeps the same string in IndexedDB; the CLI keeps it in a
 * file. What decides whether a stored seed is still worth using is the same
 * on both sides — `judgeDescription` in `src/lib/tor/directory-policy.ts` —
 * because it is a rule about the network, not about the storage.
 *
 * A seed on disk needs no more trust than one in IndexedDB: webtor verifies
 * the consensus against its pinned authorities before installing anything
 * from it, so an edited file costs a download and nothing else.
 */

const SEED_FILE = 'tor-directory.json';

/**
 * Where this system keeps a user's caches: `~/Library/Caches` on macOS, the
 * XDG cache directory everywhere else. The XDG base directory spec has a
 * relative `XDG_CACHE_HOME` ignored.
 */
export function defaultCacheDir(): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'ptransfer');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.cache'), 'ptransfer');
}

export interface DirectoryStore {
  /** The stored seed, if there is one and it still describes the network. */
  load(
    describe: (seed: string) => DirectoryDescription,
    onSkip?: (reason: string) => void,
  ): Promise<string | undefined>;
  /**
   * Keep a verified seed for the next run. Best effort: a failure is handed
   * to `onFail` and resolves false rather than throwing.
   */
  save(seed: string, onFail?: (reason: string) => void): Promise<boolean>;
  readonly path: string;
}

export function openDirectoryStore(
  cacheDir: string = defaultCacheDir(),
): DirectoryStore {
  const path = join(cacheDir, SEED_FILE);
  return {
    path,
    async load(describe, onSkip) {
      let seed: string;
      try {
        seed = await readFile(path, 'utf8');
      } catch {
        return undefined;
      }
      let described: DirectoryDescription | undefined;
      try {
        described = describe(seed);
      } catch {
        // An unreadable seed is the ordinary case for a file from an older
        // cache format; the client would refuse it too.
        described = undefined;
      }
      const verdict = judgeDescription(described);
      if (!verdict.usable) {
        onSkip?.(verdict.reason ?? 'it is not usable');
        return undefined;
      }
      return seed;
    },
    async save(seed, onFail) {
      // Write beside the file and rename over it, so a run interrupted
      // mid-write leaves the previous seed rather than half of a new one.
      const partial = `${path}.${process.pid}.part`;
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(partial, seed);
        await rename(partial, path);
        return true;
      } catch (error) {
        await rm(partial, { force: true }).catch(() => undefined);
        onFail?.(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
  };
}
