import { type FlateError, Zip, ZipPassThrough } from 'fflate';
import { deflateUpperBound, type TransferSource } from './transfer-source';

/**
 * One file as it goes into a generated ZIP, whatever holds it: a file the
 * tab's picker returned, or a file on disk the CLI walked to. This module
 * builds the archive from these alone, so both hosts send the same bytes.
 */
export interface ZipEntry {
  /**
   * Where the file sits in the archive, `/`-separated. A path with a folder
   * in it, like `photos/2026/a.jpg`, keeps that folder when unpacked.
   */
  path: string;
  size: number;
  /** Modification time, in milliseconds since the epoch. */
  lastModified: number;
  stream: () => ReadableStream<Uint8Array>;
}

/** "Version made by" host 3, APPNOTE 4.4.2.2. */
const ZIP_ORIGIN_UNIX = 3;
/**
 * External attributes of a Unix-made entry: the `st_mode` in the high 16
 * bits, here a regular file readable by all and writable by its owner.
 */
const ZIP_REGULAR_FILE_ATTRS = (0o100644 << 16) >>> 0;

/**
 * ZIP entry compressed with the native CompressionStream.
 *
 * fflate's streaming deflate (ZipDeflate) emits invalid back-references on
 * some inputs, producing archives whose entry data cannot be inflated even
 * though the recorded CRC is correct (101arrowz/fflate#260, #282 — present in
 * 0.8.2 and 0.8.3; deflateSync on the same bytes is unaffected). Compressing
 * natively sidesteps that bug while keeping bounded-memory, on-the-fly
 * archive generation: fflate only assembles the ZIP container.
 *
 * The inherited push() computes the entry CRC and size from the uncompressed
 * bytes; process() reroutes those bytes through the deflater, whose output is
 * pumped to ondata asynchronously — the container reads crc/size only when
 * the final compressed chunk is emitted, exactly as with AsyncZipDeflate.
 */
class ZipNativeDeflate extends ZipPassThrough {
  private readonly deflateWriter: WritableStreamDefaultWriter<BufferSource>;
  /** Resolves once every compressed byte has been handed to ondata. */
  readonly flushed: Promise<void>;

  constructor(filename: string) {
    super(filename);
    // Written into the local header at zip.add() time, so set before adding.
    this.compression = 8;
    // Made on Unix, as an ordinary file. fflate's default origin is MS-DOS,
    // and Info-ZIP's unzip — what a Linux system unpacks with — reads the
    // name of an MS-DOS entry as code page 437 even when the entry is flagged
    // UTF-8, so every non-ASCII name came out mangled. A picked file has no
    // mode to carry, so every entry gets the same one.
    this.os = ZIP_ORIGIN_UNIX;
    this.attrs = ZIP_REGULAR_FILE_ATTRS;
    const deflater = new CompressionStream('deflate-raw');
    this.deflateWriter = deflater.writable.getWriter();
    this.flushed = this.pump(deflater.readable);
  }

  private async pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.ondata(null, value, false);
      }
      this.ondata(null, new Uint8Array(0), true);
    } catch (pumpError: unknown) {
      // Surface deflater failures through the ZIP callback; flushed itself
      // always resolves so waiting on it can never dangle.
      this.ondata(pumpError as FlateError, new Uint8Array(0), true);
    }
  }

  protected process(chunk: Uint8Array, final: boolean): void {
    // Rejections propagate through the deflater's readable into pump().
    // Source-stream chunks are always backed by a plain ArrayBuffer.
    void this.deflateWriter
      .write(chunk as Uint8Array<ArrayBuffer>)
      .catch(() => {});
    if (final) void this.deflateWriter.close().catch(() => {});
  }

  /** Aborts compression when the archive is cancelled mid-entry. */
  terminate(): void {
    void this.deflateWriter.abort().catch(() => {});
  }
}

/**
 * What one ZIP entry costs beyond its own bytes: a local file header, a
 * streaming data descriptor, and a central directory record, plus zip64 extra
 * fields. The entry path is stored twice, so it is counted separately.
 */
const ZIP_PER_ENTRY_BYTES = 160;
/** End-of-central-directory, plus the zip64 records that may precede it. */
const ZIP_TRAILER_BYTES = 128;

/**
 * An upper bound on the archive a selection will produce. Every entry is
 * deflated individually, so each contributes its own deflate bound as well as
 * its share of the ZIP's bookkeeping — which is what makes a selection of many
 * tiny files cost far more on the wire than the sum of its file sizes.
 */
export function zipWireUpperBound(entries: readonly ZipEntry[]): number {
  let total = ZIP_TRAILER_BYTES;
  for (const entry of entries) {
    total +=
      deflateUpperBound(entry.size) +
      ZIP_PER_ENTRY_BYTES +
      2 * new TextEncoder().encode(entry.path).length;
  }
  return total;
}

/**
 * Create a ZIP transfer source without generating the archive up front.
 * Works with both folder selection and multi-file selection.
 *
 * Opening the source starts archive generation: entries are deflated with the
 * native CompressionStream and each ZIP output chunk is handed directly to
 * the transfer consumer. The TransformStream writer supplies backpressure, so
 * neither the selected files nor the generated archive are materialized.
 *
 * @param entries - The files, each under the path it takes in the archive
 * @param archiveName - Name for the ZIP file (without .zip extension)
 */
export function createZipTransferSource(
  entries: readonly ZipEntry[],
  archiveName: string,
): TransferSource {
  const totalInputBytes = entries.reduce(
    (total, entry) => total + entry.size,
    0,
  );
  return {
    name: `${archiveName}.zip`,
    type: 'application/zip',
    // The archive is deliberately exposed as a streamed, unknown-size source;
    // the input total remains useful as a progress/storage hint.
    size: null,
    estimatedSize: totalInputBytes,
    // Not the input total: every entry carries a header pair and its path, so
    // a selection of many tiny files occupies far more than its file sizes.
    projectedWireBytes: zipWireUpperBound(entries),
    // The entries are deflated below, so the transfer pipeline must not
    // compress this payload again (the no-recompress rule).
    precompressed: true,
    stream: () => createZipStream(entries),
  };
}

function createZipStream(
  entries: readonly ZipEntry[],
): ReadableStream<Uint8Array> {
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();

  void writeZip(entries, writer).then(
    () => writer.close(),
    (error: unknown) => writer.abort(error).catch(() => {}),
  );

  return transform.readable;
}

/**
 * `lastModified` moved into the range a ZIP header can record. The header
 * stores a local date with the year counted from 1980 in seven bits, and
 * fflate throws outright for anything outside it. Plenty of real files are
 * dated 1970 — a Nix store, a reproducible build — and must not fail a
 * transfer mid-stream.
 */
export function zipMtime(lastModified: number): number {
  const earliest = new Date(1980, 0, 1).getTime();
  const latest = new Date(2099, 11, 31, 23, 59, 58).getTime();
  return Math.min(Math.max(lastModified, earliest), latest);
}

async function writeZip(
  entries: readonly ZipEntry[],
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  let failure: Error | null = null;
  let pending: Promise<void> = Promise.resolve();
  // Only ever cancelled from outside. Under Bun, `getReader()` returns a
  // reader type that the global `ReadableStreamDefaultReader` does not match.
  let activeReader: { cancel(reason?: unknown): Promise<void> } | null = null;
  let activeEntry: ZipNativeDeflate | null = null;

  const ended = new Promise<void>((resolve, reject) => {
    // Cancelling the transfer's reader errors the TransformStream writable.
    // Propagate that cancellation into whichever file is currently being
    // read so ZIP production cannot remain blocked on file I/O.
    void writer.closed.catch((streamError: unknown) => {
      if (failure) return;
      failure =
        streamError instanceof Error
          ? streamError
          : new Error('Archive stream cancelled');
      void activeReader?.cancel(failure).catch(() => {});
      activeEntry?.terminate();
      reject(failure);
    });

    const zip = new Zip((err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = err;
        reject(err);
        return;
      }
      // fflate owns callback buffers and may reuse them as soon as this
      // callback returns. Take ownership synchronously, before a backpressured
      // writer gets a chance to delay the actual write.
      const ownedChunk = chunk.slice();
      pending = pending
        .then(() => writer.write(ownedChunk))
        .catch((appendError: unknown) => {
          if (failure) return;
          failure =
            appendError instanceof Error
              ? appendError
              : new Error('Failed to stream archive data');
          reject(failure);
        });
      if (final) {
        void pending.then(() => {
          if (!failure) resolve();
        });
      }
    });

    void (async () => {
      for (const file of entries) {
        const entry = new ZipNativeDeflate(file.path);
        entry.mtime = zipMtime(file.lastModified);
        zip.add(entry);
        activeEntry = entry;

        const reader = file.stream().getReader();
        activeReader = reader;
        try {
          while (true) {
            if (failure) return;
            const { done, value } = await reader.read();
            if (done) {
              entry.push(new Uint8Array(0), true);
              // Wait for the deflater to flush and for every emitted chunk to
              // reach the consumer before adding the next entry, so
              // backpressure also applies at file boundaries.
              await entry.flushed;
              await pending;
              break;
            }
            entry.push(value);
            // Backpressure: let queued archive output reach the consumer before
            // producing more, so memory stays bounded by in-flight chunks.
            await pending;
          }
        } finally {
          activeReader = null;
          activeEntry = null;
          reader.releaseLock();
          if (failure) entry.terminate();
        }
      }
      zip.end();
    })().catch((readError: unknown) => {
      if (failure) return;
      failure =
        readError instanceof Error
          ? readError
          : new Error('Failed to read file for archiving');
      reject(failure);
    });
  });

  await ended;
}

/**
 * Local-time `yyyymmddhhmmss` stamp appended to archive names, so repeated
 * sends of the same selection don't all arrive under one file name.
 */
export function archiveTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Base name for the ZIP of a selection: the folder name when every entry
 * sits in the same top-level folder (its path is
 * "folderName/subfolder/file.txt"), otherwise 'files'.
 */
export function getArchiveBaseName(entries: readonly ZipEntry[]): string {
  const topFolderOf = (entry: ZipEntry) => {
    const slash = entry.path.indexOf('/');
    return slash > 0 ? entry.path.slice(0, slash) : null;
  };
  const topFolder = entries[0] ? topFolderOf(entries[0]) : null;
  if (topFolder && entries.every((entry) => topFolderOf(entry) === topFolder)) {
    return topFolder;
  }
  return 'files';
}
