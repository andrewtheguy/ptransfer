import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Reading a directory for the path picker.
 *
 * Only real directories and regular files are listed: a symbolic link or a
 * special file is not something `openSelection` will send, so offering one
 * would be offering a transfer that silently leaves it out. Sizes come from a
 * second `stat` on files alone — a directory's weight is only known once it is
 * walked, which is what continuing to the mode screen does.
 *
 * Unix only, as the rest of `cli/` is: `/` is the only separator and the root
 * is the only directory that is its own parent.
 */

export interface Entry {
  /** The name inside its directory, as it is shown. */
  name: string;
  /** The absolute path, which is what a marked entry contributes. */
  path: string;
  directory: boolean;
  /** A file's size in bytes; null for a directory, whose weight is unknown. */
  size: number | null;
}

/** The directory above `dir`, or null when `dir` is the root. */
export function parentOf(dir: string): string | null {
  const absolute = resolve(dir);
  const above = dirname(absolute);
  return above === absolute ? null : above;
}

/** A path under the home directory written with a `~`, for a heading. */
export function shortenPath(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * What `dir` holds, directories first and then files, each by name. A dot file
 * is left out unless `showHidden`.
 */
export async function listDirectory(
  dir: string,
  showHidden: boolean,
): Promise<Entry[]> {
  const absolute = resolve(dir);
  const found = await readdir(absolute, { withFileTypes: true });
  const entries: Entry[] = [];
  for (const item of found) {
    if (!showHidden && item.name.startsWith('.')) continue;
    const directory = item.isDirectory();
    if (!directory && !item.isFile()) continue;
    const path = join(absolute, item.name);
    let size: number | null = null;
    if (!directory) {
      try {
        size = (await stat(path)).size;
      } catch {
        // It went away between the listing and the stat; it is still worth
        // showing, just without a size.
        size = null;
      }
    }
    entries.push({ name: item.name, path, directory, size });
  }
  entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return entries;
}
