import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Where this system keeps a user's caches: `~/Library/Caches` on macOS,
 * `%LOCALAPPDATA%\ptransfer\cache` on Windows — the local, never-roaming half
 * of the profile — and the XDG cache directory everywhere else. The XDG base
 * directory spec has a relative `XDG_CACHE_HOME` ignored. The Tor directory
 * seed and the relay cache both live here, and `--cache-dir` moves them
 * together.
 */
export function defaultCacheDir(): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'ptransfer');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    return join(
      local && isAbsolute(local) ? local : join(home, 'AppData', 'Local'),
      'ptransfer',
      'cache',
    );
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.cache'), 'ptransfer');
}
