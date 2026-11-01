import { openAsBlob, type Stats } from 'node:fs';
import {
  constants,
  type FileHandle,
  lstat,
  open,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppendSink } from '@/lib/append-sink';
import { SourceError } from '@/lib/errors';
import { t } from '@/lib/i18n';
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
    throw new Error(
      t({ en: `No such file: ${path}`, es: `No existe el archivo: ${path}` }),
    );
  }
  if (!info.isFile()) {
    throw new Error(
      t({
        en: `Not a regular file: ${path}`,
        es: `No es un archivo normal: ${path}`,
      }),
    );
  }

  return {
    name: basename(path),
    type: mimeTypeOf(path),
    size: info.size,
    estimatedSize: info.size,
    projectedWireBytes: deflateUpperBound(info.size),
    archive: false,
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
      t({
        en: `${path} changed after it was chosen; send it again`,
        es: `${path} cambió después de elegirlo; vuelve a enviarlo`,
      }),
      "A file being sent changed on the sender's side",
    );
  const unreadable = () =>
    new SourceError(
      t({ en: `Cannot read ${path}`, es: `No se puede leer ${path}` }),
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
      try {
        handle = followLink
          ? await open(path, constants.O_RDONLY)
          : await openNoFollow(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOENT') throw changed();
        throw unreadable();
      }
      let now: Stats;
      try {
        now = await handle.stat();
      } catch {
        await close();
        throw unreadable();
      }
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
 * `path` opened for reading, refused with `ELOOP` when it is a symbolic link,
 * so a link swapped in for a file found in a folder is not followed out of
 * it. Unix says so in the open itself, with `O_NOFOLLOW`. Windows has no such
 * flag, so there the file is opened and then held to the `lstat` of its path:
 * a link — a junction included — or a different file is refused. The check
 * comes after the open, so a link put back in place between the two is not
 * seen; what was opened is still a file that was at that path.
 */
export async function openNoFollow(path: string): Promise<FileHandle> {
  if (process.platform !== 'win32') {
    return open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  const handle = await open(path, constants.O_RDONLY);
  try {
    const [opened, named] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    ) {
      throw Object.assign(
        new Error(t({ en: `${path} is a link`, es: `${path} es un enlace` })),
        { code: 'ELOOP' },
      );
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * What the file says it is, from its extension. Bun keeps the table; Node,
 * which runs the unit tests where it is installed, has none, and falls back
 * to the generic type. The receiver only ever uses it as a label.
 */
export function mimeTypeOf(path: string): string {
  const sniffed =
    typeof Bun === 'undefined' ? '' : Bun.file(path).type.split(';')[0];
  return sniffed || 'application/octet-stream';
}

/**
 * The longest file name a file system takes: 255 bytes of UTF-8 on Linux and
 * macOS, 255 UTF-16 units on Windows (NTFS, exFAT and FAT alike).
 */
const NAME_MAX = 255;
/** What a part file adds to its destination's name: `.<8 hex>.part`. */
const PART_SUFFIX_LENGTH = 14;

const WINDOWS = process.platform === 'win32';

/** A name's length as the file system counts it. */
function nameLength(name: string, windows: boolean): number {
  return windows ? name.length : new TextEncoder().encode(name).length;
}

/**
 * Windows' reserved device names. A file name whose part before the first
 * dot is one of these — `nul.tar.gz` as much as `NUL` — is the device, not a
 * file, to everything that goes through Win32 path handling.
 */
const WINDOWS_RESERVED =
  /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³])$/i;

/**
 * The name a received file is saved under: the sender's, reduced to one
 * path segment with nothing in it a file name cannot hold. A sender chose it,
 * so it is not trusted to stay in the directory it was given.
 *
 * On Linux and macOS `/` is the only separator, and a backslash is an
 * ordinary character in a file name, kept. On Windows `\` separates too, and
 * a name must also lose what Win32 will not take: `<>:"|?*`, each replaced
 * with `_` — a `:` would otherwise name an NTFS alternate data stream of
 * another file — trailing dots and spaces, and the reserved device names,
 * which are prefixed with `_`. Bun writes through `\\?\` paths, which skip
 * those checks, so a name that breaks them is created rather than refused,
 * as a file Explorer cannot open or delete.
 */
export function safeFileName(
  name: string,
  windows = WINDOWS,
  limit = NAME_MAX,
): string {
  const segment = name.split(windows ? /[\\/]/ : '/').pop() ?? '';
  // Every control character, C1 included: U+009B alone is a terminal escape.
  let cleaned = segment.replace(/\p{Cc}/gu, '').trim();
  if (windows) cleaned = windowsName(cleaned);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'received';
  const fitted = fitName(cleaned, limit, windows);
  // Cutting can end the name on a dot or a space again.
  return windows ? windowsName(fitted) || 'received' : fitted;
}

/**
 * The longest path Win32 takes without the long-path opt-in, in UTF-16
 * units, its terminating NUL left out. Bun gets past it, but Explorer, `cmd`
 * and most programs a received file is opened with do not.
 */
const WINDOWS_MAX_PATH = 259;
/**
 * The shortest a name is cut to to keep a path within `WINDOWS_MAX_PATH`, so
 * that a folder already near the limit still gets a name that says what the
 * file is, with its extension.
 */
const WINDOWS_NAME_FLOOR = 32;

/**
 * Where the file a sender called `name` is saved in `folder`: `safeFileName`
 * in it. On Windows the whole path is also kept within `MAX_PATH` where the
 * folder leaves room for that, by cutting the name further.
 */
export function savePath(
  folder: string,
  name: string,
  windows = WINDOWS,
): string {
  if (!windows) return join(folder, safeFileName(name, false));
  // The folder as a prefix, separator included, whether or not it ends in one.
  const prefix = join(folder, '_').length - 1;
  const room = Math.max(WINDOWS_MAX_PATH - prefix, WINDOWS_NAME_FLOOR);
  return join(folder, safeFileName(name, true, Math.min(NAME_MAX, room)));
}

function windowsName(name: string): string {
  const cleaned = name.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  const stem = cleaned.split('.')[0].trimEnd();
  return WINDOWS_RESERVED.test(stem) ? `_${cleaned}` : cleaned;
}

/**
 * `name` cut to at most `limit` of what the file system counts, at a
 * character boundary, keeping a short extension. A sender's system may allow
 * longer names than this one — 255 UTF-16 units is up to 765 bytes — and a
 * name the file system refuses would fail the transfer only after the
 * handshake.
 */
function fitName(name: string, limit: number, windows: boolean): string {
  if (nameLength(name, windows) <= limit) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  let fitted = '';
  let used = nameLength(extension, windows);
  for (const char of name.slice(0, name.length - extension.length)) {
    used += nameLength(char, windows);
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
 *
 * Whether a file can be created is found out by creating one, and removing
 * it: `access` asks about mode bits, which on Windows are only the read-only
 * attribute and say nothing of the folder's ACL, and anywhere can miss what
 * the file system itself will refuse.
 */
export async function destinationFolder(path: string): Promise<string> {
  const absolute = resolve(path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(
      t({
        en: `No such folder: ${path}`,
        es: `No existe la carpeta: ${path}`,
      }),
    );
  }
  if (!info.isDirectory()) {
    throw new Error(
      t({ en: `Not a folder: ${path}`, es: `No es una carpeta: ${path}` }),
    );
  }
  const probe = join(
    absolute,
    `.ptransfer-${crypto.randomUUID().slice(0, 8)}.probe`,
  );
  try {
    await (await open(probe, 'wx')).close();
  } catch {
    throw new Error(
      t({
        en: `Cannot save files in ${path}`,
        es: `No se pueden guardar archivos en ${path}`,
      }),
    );
  }
  // The folder has answered the question; a probe that will not go away —
  // on Windows, a scanner holding the new file open — is not a reason to
  // refuse it.
  await rm(probe, { force: true }).catch(() => undefined);
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
    NAME_MAX - PART_SUFFIX_LENGTH,
    WINDOWS,
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
        if (!handle) throw discardedError();
        await handle.write(data);
      });
    },
    finish() {
      return enqueue(async () => {
        if (!handle) throw discardedError();
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

function discardedError(): Error {
  return new Error(
    t({
      en: 'The destination file was discarded',
      es: 'El archivo de destino se descartó',
    }),
  );
}

async function refuseExisting(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    return;
  }
  throw new Error(t({ en: `${path} already exists`, es: `${path} ya existe` }));
}
