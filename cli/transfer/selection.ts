import type { Dirent, Stats } from 'node:fs';
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  archiveTimestamp,
  createZipTransferSource,
  getArchiveBaseName,
  type ZipEntry,
} from '@/lib/folder-utils';
import type { TransferSource } from '@/lib/transfer-source';
import {
  chosenFileStream,
  mimeTypeOf,
  openFileSource,
  openNoFollow,
} from './files';

/**
 * The paths `send` was given, as one transfer source, by the rule the tab
 * applies to a selection: a lone regular file travels as itself, and
 * anything else — several paths, or a folder — as a ZIP generated while it is
 * sent. The ZIP is built by the tab's own code from entries found on disk, so
 * a receiver cannot tell which host packed it.
 */

export interface Selection {
  source: TransferSource;
  /** How many files the source carries: one, or the ZIP's entries. */
  fileCount: number;
  /**
   * What a folder held that a ZIP of regular files does not carry — symbolic
   * links, sockets, devices — and so was left out.
   */
  skipped: string[];
}

export async function openSelection(
  paths: readonly string[],
): Promise<Selection> {
  if (paths.length === 1 && (await statPath(paths[0])).isFile()) {
    return {
      source: await openFileSource(paths[0]),
      fileCount: 1,
      skipped: [],
    };
  }
  const { entries, skipped } = await collectEntries(paths);
  const archiveName = `${getArchiveBaseName(entries)}_${archiveTimestamp()}`;
  return {
    source: createZipTransferSource(entries, archiveName),
    fileCount: entries.length,
    skipped,
  };
}

/**
 * Every regular file under `paths`, each stored in the archive under the
 * name of the path it was reached from: a file as its own name, a folder's
 * contents under the folder's name, the way the tab stores a picked folder.
 *
 * A path given on the command line is followed if it is a symbolic link —
 * someone named it — but a link found inside a folder is left out, which
 * also keeps a link back up the tree from walking forever. Empty folders are
 * not stored, as they are not in the tab's ZIP.
 */
async function collectEntries(
  paths: readonly string[],
): Promise<{ entries: ZipEntry[]; skipped: string[] }> {
  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  // Each path's name is the top of the archive, so two paths with one name
  // would unpack on top of each other.
  const named = new Map<string, string>();
  for (const path of paths) {
    const info = await statPath(path);
    const name = basename(resolve(path));
    if (name === '') throw new Error('The root folder cannot be sent');
    const clash = named.get(name);
    if (clash !== undefined) {
      throw new Error(
        `${clash} and ${path} would both be ${name} in the archive; rename one, or send them separately`,
      );
    }
    named.set(name, path);
    if (info.isFile()) {
      entries.push(await namedEntry(path, name, info));
    } else if (info.isDirectory()) {
      await walk(path, await realPathOf(path), name, entries, skipped);
    } else {
      throw new Error(`Not a regular file or folder: ${path}`);
    }
  }
  if (entries.length === 0) {
    throw new Error(`Nothing to send: ${paths.join(', ')} holds no files`);
  }
  return { entries, skipped };
}

/**
 * The files under `folder`, which the walk reached at `real`: the path it
 * has when no link is followed. A folder is read, and a file taken, only while
 * its real path is still the one reached through the chosen folder, so a
 * folder swapped for a link while the walk is elsewhere cannot bring files
 * from outside into the archive.
 */
async function walk(
  folder: string,
  real: string,
  prefix: string,
  entries: ZipEntry[],
  skipped: string[],
): Promise<void> {
  let children: Dirent[];
  try {
    children = await readdir(folder, { withFileTypes: true });
  } catch {
    throw new Error(`Cannot read the folder ${folder}`);
  }
  // By code point, not locale: the same tree packs the same way everywhere.
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const child of children) {
    const path = join(folder, child.name);
    const realChild = join(real, child.name);
    const inArchive = `${prefix}/${child.name}`;
    if (child.isDirectory()) {
      await expectRealPath(path, realChild);
      await walk(path, realChild, inArchive, entries, skipped);
    } else if (child.isFile()) {
      entries.push(await walkedEntry(path, realChild, inArchive));
    } else {
      skipped.push(path);
    }
  }
}

/**
 * A file named on the command line as a ZIP entry. It is checked for
 * readability now: the archive is only generated once a receiver has
 * connected, and a file that cannot be read would fail the transfer after a
 * Tor bootstrap and a handshake, where there is no resume. Opening it is
 * the check: `access` asks about mode bits, which on Windows say nothing of
 * the file's ACL. Someone named it, so a symbolic link to it is followed.
 */
async function namedEntry(
  path: string,
  inArchive: string,
  info: Stats,
): Promise<ZipEntry> {
  try {
    await (await open(path, 'r')).close();
  } catch {
    throw new Error(`Cannot read ${path}`);
  }
  return diskEntry(path, inArchive, info, true);
}

/**
 * A file the walk found at `real` as a ZIP entry. Opening it is the
 * readability check, and pins what is recorded to the file opened: not a
 * link, and, checked once it is open, still inside the chosen folder.
 */
async function walkedEntry(
  path: string,
  real: string,
  inArchive: string,
): Promise<ZipEntry> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOENT') throw changedWhileRead(path);
    throw new Error(`Cannot read ${path}`);
  }
  let info: Stats;
  try {
    info = await handle.stat();
  } catch {
    throw new Error(`Cannot read ${path}`);
  } finally {
    await handle.close();
  }
  await expectRealPath(path, real);
  if (!info.isFile()) throw changedWhileRead(path);
  return diskEntry(path, inArchive, info, false);
}

function diskEntry(
  path: string,
  inArchive: string,
  info: Stats,
  followLink: boolean,
): ZipEntry {
  return {
    path: inArchive,
    type: mimeTypeOf(path),
    size: info.size,
    lastModified: info.mtimeMs,
    // A fresh read each time, as for a single file: a receiver that declines
    // leaves the service waiting, and the next one gets the whole archive.
    stream: () => chosenFileStream(path, info, followLink),
  };
}

/** Throws unless `path`, followed through any link, ends up at `expected`. */
async function expectRealPath(path: string, expected: string): Promise<void> {
  if ((await realPathOf(path)) !== expected) throw changedWhileRead(path);
}

async function realPathOf(path: string): Promise<string> {
  try {
    return process.platform === 'win32'
      ? await realpath(path)
      : await followLinks(path);
  } catch {
    throw new Error(`Cannot read ${path}`);
  }
}

/** As many links as one path may pass through, as Linux's own limit. */
const MAX_LINKS = 40;

/**
 * `realpath` on Linux and macOS, one name at a time with `lstat` and
 * `readlink`. Bun's own reads a backslash in a name as a separator there —
 * `photos/a\b.txt` is looked up as `photos/a/b.txt` — so a folder holding
 * such a file, which a ZIP may carry, could not be sent at all.
 */
async function followLinks(path: string): Promise<string> {
  // Not `resolve`: it takes `..` away before the links ahead of it are
  // followed, which is not where the system's lookup goes.
  const absolute = path.startsWith('/') ? path : `${process.cwd()}/${path}`;
  const pending = absolute.split('/').filter((name) => name !== '');
  let current = '/';
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    if (name === '.') continue;
    if (name === '..') {
      current = dirname(current);
      continue;
    }
    const next = current === '/' ? `/${name}` : `${current}/${name}`;
    if (!(await lstat(next)).isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++links > MAX_LINKS) {
      throw Object.assign(new Error(`Too many links in ${path}`), {
        code: 'ELOOP',
      });
    }
    const target = await readlink(next);
    pending.unshift(...target.split('/').filter((part) => part !== ''));
    if (target.startsWith('/')) current = '/';
  }
  return current;
}

function changedWhileRead(path: string): Error {
  return new Error(`${path} changed while its folder was read; send it again`);
}

async function statPath(path: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No such file or folder: ${path}`);
    }
    throw new Error(`Cannot read ${path}`);
  }
}
