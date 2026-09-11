import { openAsBlob, type Stats } from 'node:fs';
import {
  access,
  constants,
  type FileHandle,
  open,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppendSink } from '@/lib/append-sink';
import { SourceError } from '@/lib/errors';
import { deflateUpperBound, type TransferSource } from '@/lib/transfer-source';

/**
 * Files as the transfer layer sees them: a path as a `TransferSource`, and a
 * destination as an `AppendSink`. This is the CLI's half of the platform
 * seam the browser tab fills with a picked `File` and its scratch storage.
 */

/** A regular file on disk as a lazily opened, repeatable transfer source. */
export async function openFileSource(path: string): Promise<TransferSource> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`No such file: ${path}`);
  }
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);

  return {
    name: basename(path),
    type: mimeTypeOf(path),
    size: info.size,
    estimatedSize: info.size,
    projectedWireBytes: deflateUpperBound(info.size),
    precompressed: false,
    // A fresh read each time: a receiver that declines leaves the service
    // waiting, and the next one gets the file from the start. It was named on
    // the command line, so a symbolic link to it is followed.
    stream: () => chosenFileStream(path, info, true),
  };
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * The file `path` was when it was chosen, as a stream. It is read only once
 * a receiver has connected, and again for the next one, so it is opened
 * again each time and refused if it has changed since: another file in its
 * place, a symbolic link where `followLink` says none may be, or a different
 * length — none of which should go out under what was chosen. Either failure
 * is a `SourceError`: the receiver is told without the path.
 */
export function chosenFileStream(
  path: string,
  chosen: Stats,
  followLink: boolean,
): ReadableStream<Uint8Array> {
  const changed = () =>
    new SourceError(
      `${path} changed after it was chosen; send it again`,
      "A file being sent changed on the sender's side",
    );
  const unreadable = () =>
    new SourceError(
      `Cannot read ${path}`,
      'The sender could not read a file being sent',
    );
  let handle: FileHandle | null = null;
  let read = 0;
  const close = async () => {
    const opened = handle;
    handle = null;
    await opened?.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async start() {
      const flags = followLink
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
      try {
        handle = await open(path, flags);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOENT') throw changed();
        throw unreadable();
      }
      const now = await handle.stat().catch(async () => {
        await close();
        throw unreadable();
      });
      if (
        !now.isFile() ||
        now.dev !== chosen.dev ||
        now.ino !== chosen.ino ||
        now.size !== chosen.size
      ) {
        await close();
        throw changed();
      }
    },
    async pull(controller) {
      if (!handle) return;
      try {
        const buffer = new Uint8Array(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        read += bytesRead;
        // Its length was checked on opening; this catches it changing while
        // it is read, so the stream is never more or less than was chosen.
        if (read > chosen.size || (bytesRead === 0 && read < chosen.size)) {
          throw changed();
        }
        if (bytesRead === 0) {
          await close();
          controller.close();
          return;
        }
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) {
        await close();
        throw error instanceof SourceError ? error : unreadable();
      }
    },
    cancel: close,
  });
}

/**
 * What the file says it is, from its extension. Bun keeps the table; the
 * unit tests run under Node, which has none, and fall back to the generic
 * type. The receiver only ever uses it as a label.
 */
function mimeTypeOf(path: string): string {
  const sniffed =
    typeof Bun === 'undefined' ? '' : Bun.file(path).type.split(';')[0];
  return sniffed || 'application/octet-stream';
}

/** The longest file name Linux and macOS file systems take, in bytes. */
const NAME_MAX_BYTES = 255;
/** What a part file adds to its destination's name: `.<8 hex>.part`. */
const PART_SUFFIX_BYTES = 14;

/**
 * The name a received file is saved under: the sender's, reduced to one
 * path segment with nothing in it a file name cannot hold. A sender chose it,
 * so it is not trusted to stay in the directory it was given.
 *
 * `/` is the only separator a Unix path has; a backslash is an ordinary
 * character in a file name here, and is kept.
 */
export function safeFileName(name: string): string {
  const segment = name.split('/').pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being stripped
  const cleaned = segment.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'received';
  return fitName(cleaned, NAME_MAX_BYTES);
}

/**
 * `name` cut to at most `limit` bytes of UTF-8, at a character boundary,
 * keeping a short extension. A sender's system may allow longer names than
 * this one — 255 UTF-16 units is up to 765 bytes — and a name the file
 * system refuses would fail the transfer only after the handshake.
 */
function fitName(name: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(name).length <= limit) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  let fitted = '';
  let used = encoder.encode(extension).length;
  for (const char of name.slice(0, name.length - extension.length)) {
    used += encoder.encode(char).length;
    if (used > limit) break;
    fitted += char;
  }
  return fitted + extension;
}

/**
 * The folder a received file is saved in, as an absolute path, once it is
 * known to be a folder this process can create files in. It is checked
 * before the bootstrap, since finding out after the handshake costs a Tor
 * bootstrap and a circuit for nothing. It is never created: a mistyped name
 * should fail, not quietly collect files somewhere new.
 */
export async function destinationFolder(path: string): Promise<string> {
  const absolute = resolve(path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`No such folder: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`Not a folder: ${path}`);
  try {
    // Creating a file in a folder takes write and search permission on it.
    await access(absolute, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`Cannot save files in ${path}`);
  }
  return absolute;
}

/**
 * A destination file as an append sink. Bytes go to a `.part` file beside
 * the destination and take its name only once the sender's `end` has checked
 * out, so a transfer that fails leaves no half-file under the real name.
 *
 * The destination must not exist when the sink is created or when it is
 * finished, so a file that appears while the transfer runs is not replaced.
 * The finished file is the payload, so a finished sink has nothing to discard.
 */
export async function createFileSink(destination: string): Promise<AppendSink> {
  await refuseExisting(destination);
  // The part file's name fits wherever the destination's does.
  const stem = fitName(
    basename(destination),
    NAME_MAX_BYTES - PART_SUFFIX_BYTES,
  );
  const partial = join(
    dirname(destination),
    `${stem}.${crypto.randomUUID().slice(0, 8)}.part`,
  );
  // Exclusive: two receivers in one directory get two part files, never one.
  let handle: FileHandle | null = await open(partial, 'wx');
  let chain: Promise<unknown> = Promise.resolve();
  let finished = false;

  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = chain.then(op);
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    append(bytes) {
      // Copy before queueing: the write may run after the producer has moved
      // on, and the sink must not depend on the caller's buffer staying put.
      const data = bytes.slice();
      return enqueue(async () => {
        if (!handle) throw new Error('The destination file was discarded');
        await handle.write(data);
      });
    },
    finish() {
      return enqueue(async () => {
        if (!handle) throw new Error('The destination file was discarded');
        await handle.close();
        handle = null;
        // The part file sits beside the destination, so the move is a
        // rename within one file system: the file appears whole or not at
        // all. A rename replaces what holds the name, so it is checked for
        // first; the check and the rename are not one step, and a file that
        // appears between them is replaced.
        await refuseExisting(destination);
        await rename(partial, destination);
        finished = true;
        return openAsBlob(destination);
      });
    },
    discard() {
      return enqueue(async () => {
        if (finished) return;
        if (handle) {
          await handle.close().catch(() => undefined);
          handle = null;
        }
        await rm(partial, { force: true });
      });
    },
  };
}

async function refuseExisting(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    return;
  }
  throw new Error(`${path} already exists`);
}
