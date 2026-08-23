import { type FlateError, Zip, ZipPassThrough } from 'fflate';
import type { TransferSource } from './transfer-source';

/**
 * ZIP entry compressed with the browser's native CompressionStream.
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
    // File-stream chunks are always backed by a plain ArrayBuffer.
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
 * Check if folder selection is supported by the browser
 */
export const supportsFolderSelection =
  typeof HTMLInputElement !== 'undefined' &&
  'webkitdirectory' in HTMLInputElement.prototype;

/**
 * Create a ZIP transfer source without generating the archive up front.
 * Works with both folder selection (webkitdirectory) and multi-file selection.
 *
 * Opening the source starts archive generation: entries are deflated with the
 * browser's native CompressionStream and each ZIP output chunk is handed
 * directly to the transfer consumer. The TransformStream writer supplies
 * backpressure, so neither the selected files nor the generated archive are
 * materialized.
 *
 * @param files - Selected files; `webkitRelativePath` (when set) becomes the
 *   entry path, preserving folder structure
 * @param archiveName - Name for the ZIP file (without .zip extension)
 */
export function createZipTransferSource(
  files: readonly File[],
  archiveName: string,
): TransferSource {
  const totalInputBytes = files.reduce((total, file) => total + file.size, 0);
  return {
    name: `${archiveName}.zip`,
    type: 'application/zip',
    // The archive is deliberately exposed as a streamed, unknown-size source;
    // the input total remains useful as a progress/storage hint.
    size: null,
    estimatedSize: totalInputBytes,
    // The entries are deflated below, so the transfer pipeline must not
    // compress this payload again (the no-recompress rule).
    precompressed: true,
    stream: () => createZipStream(files),
  };
}

function createZipStream(files: readonly File[]): ReadableStream<Uint8Array> {
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();

  void writeZip(files, writer).then(
    () => writer.close(),
    (error: unknown) => writer.abort(error).catch(() => {}),
  );

  return transform.readable;
}

async function writeZip(
  files: readonly File[],
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  let failure: Error | null = null;
  let pending: Promise<void> = Promise.resolve();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let activeEntry: ZipNativeDeflate | null = null;

  const ended = new Promise<void>((resolve, reject) => {
    // Cancelling the transfer's reader errors the TransformStream writable.
    // Propagate that cancellation into whichever picker file is currently
    // being read so ZIP production cannot remain blocked on file I/O.
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
      for (const file of files) {
        // webkitRelativePath is set for folder selection, empty for multi-file
        const path = file.webkitRelativePath || file.name;
        const entry = new ZipNativeDeflate(path);
        entry.mtime = file.lastModified;
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
 * Base name for the ZIP of a mixed selection: the folder name when every file
 * came from the same selected folder (webkitRelativePath is
 * "folderName/subfolder/file.txt"), otherwise 'files'.
 */
export function getArchiveBaseName(files: readonly File[]): string {
  if (files.length === 0) return 'files';
  const topFolder = files[0].webkitRelativePath.split('/')[0];
  if (
    topFolder &&
    files.every((f) => f.webkitRelativePath.split('/')[0] === topFolder)
  ) {
    return topFolder;
  }
  return 'files';
}
