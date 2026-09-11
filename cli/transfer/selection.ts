import { createReadStream, type Dirent, type Stats } from 'node:fs';
import { access, constants, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  archiveTimestamp,
  createZipTransferSource,
  getArchiveBaseName,
  type ZipEntry,
} from '@/lib/folder-utils';
import type { TransferSource } from '@/lib/transfer-source';
import { openFileSource } from './files';

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
      entries.push(await diskEntry(path, name, info));
    } else if (info.isDirectory()) {
      await walk(path, name, entries, skipped);
    } else {
      throw new Error(`Not a regular file or folder: ${path}`);
    }
  }
  if (entries.length === 0) {
    throw new Error(`Nothing to send: ${paths.join(', ')} holds no files`);
  }
  return { entries, skipped };
}

async function walk(
  folder: string,
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
    const inArchive = `${prefix}/${child.name}`;
    if (child.isDirectory()) {
      await walk(path, inArchive, entries, skipped);
    } else if (child.isFile()) {
      entries.push(await diskEntry(path, inArchive, await statPath(path)));
    } else {
      skipped.push(path);
    }
  }
}

/**
 * A file on disk as a ZIP entry. It is checked for readability now: the
 * archive is only generated once a receiver has connected, and a file that
 * cannot be read would fail the transfer after a Tor bootstrap and a
 * handshake, where there is no resume.
 */
async function diskEntry(
  path: string,
  inArchive: string,
  info: Stats,
): Promise<ZipEntry> {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(`Cannot read ${path}`);
  }
  return {
    path: inArchive,
    size: info.size,
    lastModified: info.mtimeMs,
    // A fresh read each time, as for a single file: a receiver that declines
    // leaves the service waiting, and the next one gets the whole archive.
    stream: () =>
      Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
  };
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
