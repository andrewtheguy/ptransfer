import { readdir, stat } from 'node:fs/promises';
import { join, posix, resolve, sep, win32 } from 'node:path';

/**
 * Reading a directory for the path picker.
 *
 * Only real directories and regular files are listed: a symbolic link or a
 * special file is not something `openSelection` will send, so offering one
 * would be offering a transfer that silently leaves it out. Sizes come from a
 * second `stat` on files alone — a directory's weight is only known once it is
 * walked, which is what continuing to the mode screen does.
 *
 * Paths are the system's own: `/`-separated with one root on Linux and
 * macOS, `\`-separated with a root per drive on Windows. A root is the
 * directory that is its own parent. Windows has no one root to climb to, so
 * above every root there is one more place, `DRIVES`, which lists the drive
 * letters mounted and the network share the picker was opened on, if it was.
 * What is hidden differs too: a dot file everywhere, and on Windows also
 * anything with the hidden attribute — the profile files and `AppData` a home
 * directory there is full of.
 */

const WINDOWS = process.platform === 'win32';

/** The place above every root on Windows, where the drives are listed. */
export const DRIVES = Symbol('drives');

/** A directory, or on Windows the drives. */
export type Place = string | typeof DRIVES;

export interface Entry {
  /** The name inside its directory, as it is shown. */
  name: string;
  /** The absolute path, which is what a marked entry contributes. */
  path: string;
  directory: boolean;
  /** A file's size in bytes; null for a directory, whose weight is unknown. */
  size: number | null;
}

/**
 * The place above `place`: its directory's parent, then on Windows the drives
 * above a root, and null at the top.
 */
export function parentOf(place: Place, windows = WINDOWS): Place | null {
  if (place === DRIVES) return null;
  const path = windows ? win32 : posix;
  const absolute = path.resolve(place);
  const above = path.dirname(absolute);
  if (above !== absolute) return above;
  return windows ? DRIVES : null;
}

/** A path under the home directory written with a `~`, for a heading. */
export function shortenPath(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return '~';
  return path.startsWith(`${home}${sep}`)
    ? `~${path.slice(home.length)}`
    : path;
}

/**
 * What a place holds: the drives for `DRIVES`, a directory's listing
 * otherwise. `opened` is where the picker started, whose root is listed among
 * the drives when it is a network share — there is no other way back to it.
 */
export async function listPlace(
  place: Place,
  showHidden: boolean,
  opened: string,
): Promise<Entry[]> {
  if (place !== DRIVES) return listDirectory(place, showHidden);
  const kernel32 = await loadKernel32();
  return driveEntries(kernel32.logicalDrives(), [opened]);
}

/**
 * The drives in `mask`, `GetLogicalDrives`' bit per letter from A, then the
 * root of each of `opened` that is a network share rather than a drive.
 */
export function driveEntries(mask: number, opened: readonly string[]): Entry[] {
  const roots = Array.from({ length: 26 }, (_, bit) => bit)
    .filter((bit) => mask & (1 << bit))
    .map((bit) => `${String.fromCharCode(65 + bit)}:\\`);
  for (const path of opened) {
    const root = win32.parse(win32.resolve(path)).root;
    const known = roots.some(
      (seen) => seen.toLowerCase() === root.toLowerCase(),
    );
    if (root.startsWith('\\\\') && !known) roots.push(root);
  }
  return roots.map((root) => ({
    name: root.slice(0, -1),
    path: root,
    directory: true,
    size: null,
  }));
}

/**
 * What `dir` holds, directories first and then files, each by name. A hidden
 * entry is left out unless `showHidden`.
 */
export async function listDirectory(
  dir: string,
  showHidden: boolean,
): Promise<Entry[]> {
  const absolute = resolve(dir);
  const found = await readdir(absolute, { withFileTypes: true });
  const hidden = showHidden ? null : await hiddenTest();
  const kept = found
    .filter((item) => item.isDirectory() || item.isFile())
    .map((item) => ({
      name: item.name,
      path: join(absolute, item.name),
      directory: item.isDirectory(),
    }))
    .filter((entry) => !hidden?.(entry.name, entry.path));
  // One round of stats rather than thousands in a row: a home directory is
  // read while someone waits to see it.
  const entries: Entry[] = await Promise.all(
    kept.map(async (entry) => ({
      ...entry,
      size: entry.directory ? null : await sizeOf(entry.path),
    })),
  );
  entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return entries;
}

/** Whether an entry is hidden, by its name and, on Windows, its attributes. */
async function hiddenTest(): Promise<(name: string, path: string) => boolean> {
  if (!WINDOWS) return (name) => name.startsWith('.');
  const kernel32 = await loadKernel32();
  return (name, path) => name.startsWith('.') || kernel32.hidden(path);
}

/**
 * What a file weighs, or null when it went away between the listing and the
 * stat — it is still worth showing, just without a size.
 */
async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

interface Kernel32 {
  /** `GetLogicalDrives`: a bit per mounted drive letter, A first. */
  logicalDrives(): number;
  /** Whether `path` has the hidden attribute; false when it cannot be read. */
  hidden(path: string): boolean;
}

let kernel32: Promise<Kernel32> | undefined;

/**
 * The two Windows calls Node has no answer for, through `bun:ffi` as the lock
 * in `cli/file-lock.ts` is. Loaded only on Windows, the first time it is
 * needed.
 */
function loadKernel32(): Promise<Kernel32> {
  kernel32 ??= (async () => {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const FILE_ATTRIBUTE_HIDDEN = 0x2;
    const INVALID_FILE_ATTRIBUTES = 0xffffffff;
    const { GetLogicalDrives, GetFileAttributesW } = dlopen('kernel32.dll', {
      GetLogicalDrives: { args: [], returns: FFIType.u32 },
      GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
    }).symbols;
    return {
      logicalDrives: () => GetLogicalDrives(),
      hidden: (path) => {
        const name = Buffer.from(`${path}\0`, 'utf16le');
        const attributes = GetFileAttributesW(ptr(name));
        return (
          attributes !== INVALID_FILE_ATTRIBUTES &&
          (attributes & FILE_ATTRIBUTE_HIDDEN) !== 0
        );
      },
    };
  })();
  return kernel32;
}
