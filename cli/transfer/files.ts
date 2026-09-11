import { createReadStream, openAsBlob } from 'node:fs';
import {
  type FileHandle,
  link,
  open,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { AppendSink } from '@/lib/append-sink';
import { deflateUpperBound, type TransferSource } from '@/lib/transfer-source';

/**
 * Files as the transfer layer sees them: a path as a `TransferSource`, and a
 * destination as an `AppendSink`. This is the CLI's half of the platform
 * seam the browser tab fills with a picked `File` and its scratch storage.
 */

/** A regular file on disk as a lazily opened, repeatable transfer source. */
export async function openFileSource(path: string): Promise<TransferSource> {
  let info: Awaited<ReturnType<typeof stat>>;
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
    // waiting, and the next one gets the file from the start.
    stream: () =>
      Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
  };
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

/**
 * The name a received file is saved under: the sender's, reduced to one
 * path segment with nothing in it a file name cannot hold. A sender chose it,
 * so it is not trusted to stay in the directory it was given.
 */
export function safeFileName(name: string): string {
  const segment = name.split(/[\\/]/).pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being stripped
  const cleaned = segment.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'received';
  return cleaned;
}

/**
 * A destination file as an append sink. Bytes go to a `.part` file beside
 * the destination and take its name only once the sender's `end` has checked
 * out, so a transfer that fails leaves no half-file under the real name.
 *
 * The destination must not exist when the sink is created or when it is
 * finished; it is never overwritten, even by a file that appears in between.
 * The finished file is the payload, so a finished sink has nothing to discard.
 */
export async function createFileSink(destination: string): Promise<AppendSink> {
  await refuseExisting(destination);
  const partial = `${destination}.${crypto.randomUUID().slice(0, 8)}.part`;
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
        await installWithoutReplacing(partial, destination);
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

/**
 * Give the part file the destination's name without ever replacing a file
 * that got there first. A check followed by a rename leaves a window in which
 * another process's file appears and is replaced; `link` refuses an existing
 * name with EEXIST in the same step that would create it. The part file's
 * own name goes once the destination has the data.
 */
async function installWithoutReplacing(
  partial: string,
  destination: string,
): Promise<void> {
  try {
    await link(partial, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${destination} already exists`);
    }
    throw error;
  }
  await unlink(partial);
}
